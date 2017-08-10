/**
 * A Container is a parent class representing a container that manages a set of Messages.
 *
 * @class  layer.Container
 * @abstract
 * @extends layer.Syncable
 * @author  Michael Kantor
 */
const Syncable = require('./syncable');
const LayerError = require('../layer-error');
const Util = require('../client-utils');
const Constants = require('../const');
const Root = require('../root');

class Container extends Syncable {

  /**
   * Create a new conversation.
   *
   * The static `layer.Conversation.create()` method
   * will correctly lookup distinct Conversations and
   * return them; `new layer.Conversation()` will not.
   *
   * Developers should use `layer.Conversation.create()`.
   *
   * @method constructor
   * @protected
   * @param  {Object} options
   * @param {string[]/layer.Identity[]} options.participants - Array of Participant IDs or layer.Identity instances
   * @param {boolean} [options.distinct=true] - Is the conversation distinct
   * @param {Object} [options.metadata] - An object containing Conversation Metadata.
   * @return {layer.Conversation}
   */
  constructor(options = {}) {
    // Make sure the ID from handle fromServer parameter is used by the Root.constructor
    if (options.fromServer) options.id = options.fromServer.id;

    // Make sure we have an clientId property
    if (options.client) options.clientId = options.client.appId;
    if (!options.metadata) options.metadata = {};

    super(options);

    if (!this.clientId) throw new Error(LayerError.dictionary.clientMissing);
    this.isInitializing = true;

    // If the options contains a full server definition of the object,
    // copy it in with _populateFromServer; this will add the Conversation
    // to the Client as well.
    if (options && options.fromServer) {
      this._populateFromServer(options.fromServer);
    }

    if (!this.metadata) this.metadata = {};

    if (!this.createdAt) {
      this.createdAt = new Date();
    }
    this.isInitializing = false;
  }


  send(message) {
    if (this.isNew()) {
      this.createdAt = new Date();

      // Update the syncState
      this._setSyncing();

      this.getClient()._triggerAsync('state-change', {
        started: true,
        type: 'send_' + Util.typeFromID(this.id),
        telemetryId: 'send_' + Util.typeFromID(this.id) + '_time',
        id: this.id,
      });
      this.getClient().sendSocketRequest({
        method: 'POST',
        body: {}, // see _getSendData
        sync: {
          depends: this.id,
          target: this.id,
        },
      }, result => this._createResult(result));
    }
    if (message) this._setupMessage(message);
    return this;
  }


  /**
   * Populates this instance using server-data.
   *
   * Side effects add this to the Client.
   *
   * @method _populateFromServer
   * @private
   * @param  {Object} container - Server representation of the container
   */
  _populateFromServer(container) {
    const client = this.getClient();

    this._setSynced();

    const id = this.id;
    this.id = container.id;

    // IDs change if the server returns a matching Container
    if (id !== this.id) {
      client._updateContainerId(this, id);
      this._triggerAsync(`${this.constructor.eventPrefix}:change`, {
        oldValue: id,
        newValue: this.id,
        property: 'id',
      });
    }

    this.url = container.url;
    this.createdAt = new Date(container.created_at);
    this.metadata = container.metadata;
  }

  /**
   * Process result of send method.
   *
   * Note that we use _triggerAsync so that
   * events reporting changes to the layer.Conversation.id can
   * be applied before reporting on it being sent.
   *
   * Example: Query will now have the resolved Distinct IDs rather than the proposed ID
   * when this event is triggered.
   *
   * @method _createResult
   * @private
   * @param  {Object} result
   */
  _createResult({ success, data }) {
    this.getClient()._triggerAsync('state-change', {
      ended: true,
      type: 'send_' + Util.typeFromID(this.id),
      telemetryId: 'send_' + Util.typeFromID(this.id) + '_time',
      id: this.id,
    });
    if (this.isDestroyed) return;
    if (success) {
      this._createSuccess(data);
    } else if (data.id === 'conflict') {
      this._createResultConflict(data);
    } else {
      this.trigger(this.constructor.eventPrefix + ':sent-error', { error: data });
      this.destroy();
    }
  }


  /**
   * Process the successful result of a create call
   *
   * @method _createSuccess
   * @private
   * @param  {Object} data Server description of Conversation/Channel
   */
  _createSuccess(data) {
    const id = this.id;
    this._populateFromServer(data);
    this._triggerAsync(this.constructor.eventPrefix + ':sent', {
      result: id === this.id ? Container.CREATED : Container.FOUND,
    });
  }


  /**
   * Updates specified metadata keys.
   *
   * Updates the local object's metadata and syncs the change to the server.
   *
   *      conversation.setMetadataProperties({
   *          'title': 'I am a title',
   *          'colors.background': 'red',
   *          'colors.text': {
   *              'fill': 'blue',
   *              'shadow': 'black'
   *           },
   *           'colors.title.fill': 'red'
   *      });
   *
   * Use setMetadataProperties to specify the path to a property, and a new value for that property.
   * Multiple properties can be changed this way.  Whatever value was there before is
   * replaced with the new value; so in the above example, whatever other keys may have
   * existed under `colors.text` have been replaced by the new object `{fill: 'blue', shadow: 'black'}`.
   *
   * Note also that only string and subobjects are accepted as values.
   *
   * Keys with '.' will update a field of an object (and create an object if it wasn't there):
   *
   * Initial metadata: {}
   *
   *      conversation.setMetadataProperties({
   *          'colors.background': 'red',
   *      });
   *
   * Metadata is now: `{colors: {background: 'red'}}`
   *
   *      conversation.setMetadataProperties({
   *          'colors.foreground': 'black',
   *      });
   *
   * Metadata is now: `{colors: {background: 'red', foreground: 'black'}}`
   *
   * Executes as follows:
   *
   * 1. Updates the metadata property of the local object
   * 2. Triggers a conversations:change event
   * 3. Submits a request to be sent to the server to update the server's object
   * 4. If there is an error, no errors are fired except by layer.SyncManager, but another
   *    conversations:change event is fired as the change is rolled back.
   *
   * @method setMetadataProperties
   * @param  {Object} properties
   * @return {layer.Conversation} this
   *
   */
  setMetadataProperties(props) {
    const layerPatchOperations = [];
    Object.keys(props).forEach((name) => {
      let fullName = name;
      if (name) {
        if (name !== 'metadata' && name.indexOf('metadata.') !== 0) {
          fullName = 'metadata.' + name;
        }
        layerPatchOperations.push({
          operation: 'set',
          property: fullName,
          value: props[name],
        });
      }
    });

    this._inLayerParser = true;

    // Do this before setSyncing as if there are any errors, we should never even
    // start setting up a request.
    Util.layerParse({
      object: this,
      type: 'Conversation',
      operations: layerPatchOperations,
      client: this.getClient(),
    });
    this._inLayerParser = false;

    this._xhr({
      url: '',
      method: 'PATCH',
      data: JSON.stringify(layerPatchOperations),
      headers: {
        'content-type': 'application/vnd.layer-patch+json',
      },
    }, (result) => {
      if (!result.success && !this.isDestroyed && result.data.id !== 'authentication_required') this._load();
    });

    return this;
  }


  /**
   * Deletes specified metadata keys.
   *
   * Updates the local object's metadata and syncs the change to the server.
   *
   *      conversation.deleteMetadataProperties(
   *          ['title', 'colors.background', 'colors.title.fill']
   *      );
   *
   * Use deleteMetadataProperties to specify paths to properties to be deleted.
   * Multiple properties can be deleted.
   *
   * Executes as follows:
   *
   * 1. Updates the metadata property of the local object
   * 2. Triggers a conversations:change event
   * 3. Submits a request to be sent to the server to update the server's object
   * 4. If there is an error, no errors are fired except by layer.SyncManager, but another
   *    conversations:change event is fired as the change is rolled back.
   *
   * @method deleteMetadataProperties
   * @param  {string[]} properties
   * @return {layer.Conversation} this
   */
  deleteMetadataProperties(props) {
    const layerPatchOperations = [];
    props.forEach((property) => {
      if (property !== 'metadata' && property.indexOf('metadata.') !== 0) {
        property = 'metadata.' + property;
      }
      layerPatchOperations.push({
        operation: 'delete',
        property,
      });
    }, this);

    this._inLayerParser = true;

    // Do this before setSyncing as if there are any errors, we should never even
    // start setting up a request.
    Util.layerParse({
      object: this,
      type: 'Conversation',
      operations: layerPatchOperations,
      client: this.getClient(),
    });
    this._inLayerParser = false;

    this._xhr({
      url: '',
      method: 'PATCH',
      data: JSON.stringify(layerPatchOperations),
      headers: {
        'content-type': 'application/vnd.layer-patch+json',
      },
    }, (result) => {
      if (!result.success && result.data.id !== 'authentication_required') this._load();
    });

    return this;
  }


  /**
   * Delete the Conversation from the server (internal version).
   *
   * This version of Delete takes a Query String that is packaged up by
   * layer.Conversation.delete and layer.Conversation.leave.
   *
   * @method _delete
   * @private
   * @param {string} queryStr - Query string for the DELETE request
   */
  _delete(queryStr) {
    const id = this.id;
    this._xhr({
      method: 'DELETE',
      url: '?' + queryStr,
    }, result => this._deleteResult(result, id));

    this._deleted();
    this.destroy();
  }

  _handleWebsocketDelete(data) {
    if (data.mode === Constants.DELETION_MODE.MY_DEVICES && data.from_position) {
      this.getClient()._purgeMessagesByPosition(this.id, data.from_position);
    } else {
      super._handleWebsocketDelete();
    }
  }

  _getUrl(url) {
    return this.url + (url || '');
  }

  _loaded(data) {
    this._register(this);
  }

  /**
   * Standard `on()` provided by layer.Root.
   *
   * Adds some special handling of 'conversations:loaded' so that calls such as
   *
   *      var c = client.getConversation('layer:///conversations/123', true)
   *      .on('conversations:loaded', function() {
   *          myrerender(c);
   *      });
   *      myrender(c); // render a placeholder for c until the details of c have loaded
   *
   * can fire their callback regardless of whether the client loads or has
   * already loaded the Conversation.
   *
   * @method on
   * @param  {string} eventName
   * @param  {Function} callback
   * @param  {Object} context
   * @return {layer.Conversation} this
   */
  on(name, callback, context) {
    const evtName = `${this.constructor.eventPrefix}:loaded`;
    const hasLoadedEvt = name === evtName || (name && typeof name === 'object' && name[evtName]);

    if (hasLoadedEvt && !this.isLoading) {
      const callNow = name === evtName ? callback : name[evtName];
      Util.defer(() => callNow.apply(context));
    }
    super.on(name, callback, context);

    return this;
  }

  _triggerAsync(evtName, args) {
    this._clearObject();
    super._triggerAsync(evtName, args);
  }

  trigger(evtName, args) {
    this._clearObject();
    super.trigger(evtName, args);
  }

  /**
   * __ Methods are automatically called by property setters.
   *
   * Any change in the metadata property will call this method and fire a
   * change event.  Changes to the metadata object that don't replace the object
   * with a new object will require directly calling this method.
   *
   * @method __updateMetadata
   * @private
   * @param  {Object} newValue
   * @param  {Object} oldValue
   */
  __updateMetadata(newValue, oldValue, paths) {
    if (this._inLayerParser) return;
    if (JSON.stringify(newValue) !== JSON.stringify(oldValue)) {
      this._triggerAsync(`${this.constructor.eventPrefix}:change`, {
        property: 'metadata',
        newValue,
        oldValue,
        paths,
      });
    }
  }

  _handlePatchEvent(newValue, oldValue, paths) {
    if (paths[0].indexOf('metadata') === 0) {
      this.__updateMetadata(newValue, oldValue, paths);
    }
  }

  /**
   * Returns a plain object.
   *
   * Object will have all the same public properties as this
   * Conversation instance.  New object is returned any time
   * any of this object's properties change.
   *
   * @method toObject
   * @return {Object} POJO version of this.
   */
  toObject() {
    if (!this._toObject) {
      this._toObject = super.toObject();
      this._toObject.metadata = Util.clone(this.metadata);
    }
    return this._toObject;
  }

  /**
   * Identifies whether a Conversation receiving the specified patch data should be loaded from the server.
   *
   * Any change to a Conversation indicates that the Conversation is active and of potential interest; go ahead and load that
   * Conversation in case the app has need of it.  In the future we may ignore changes to unread count.  Only relevant
   * when we get Websocket events for a Conversation that has not been loaded/cached on Client.
   *
   * @method _loadResourceForPatch
   * @static
   * @private
   */
  static _loadResourceForPatch(patchData) {
    return true;
  }
}

/**
 * Time that the conversation was created on the server.
 *
 * @type {Date}
 */
Container.prototype.createdAt = null;

/**
 * Metadata for the conversation.
 *
 * Metadata values can be plain objects and strings, but
 * no arrays, numbers, booleans or dates.
 * @type {Object}
 */
Container.prototype.metadata = null;


/**
 * The authenticated user is a current participant in this Conversation.
 *
 * Set to false if the authenticated user has been removed from this conversation.
 *
 * A removed user can see messages up to the time they were removed,
 * but can no longer interact with the conversation.
 *
 * A removed user can no longer see the participant list.
 *
 * Read and Delivery receipts will fail on any Message in such a Conversation.
 *
 * @type {Boolean}
 */
Container.prototype.isCurrentParticipant = true;

/**
 * The number of all messages in conversation.
 *
 * @type {Boolean}
 */
Container.prototype.totalMessageCount = 0;


/**
 * Cache's a Distinct Event.
 *
 * On creating a Channel or Conversation that already exists,
 * when the send() method is called, we should trigger
 * specific events detailing the results.  Results
 * may be determined locally or on the server, but same Event may be needed.
 *
 * @type {layer.LayerEvent}
 * @private
 */
Container.prototype._sendDistinctEvent = null;

/**
 * Caches last result of toObject()
 * @type {Object}
 * @private
 */
Container.prototype._toObject = null;



/**
 * Property to look for when bubbling up events.
 * @type {String}
 * @static
 * @private
 */
Container.bubbleEventParent = 'getClient';

/**
 * The Conversation/Channel that was requested has been created.
 *
 * Used in `conversations:sent` events.
 * @type {String}
 * @static
 */
Container.CREATED = 'Created';

/**
 * The Conversation/Channel that was requested has been found.
 *
 * This means that it did not need to be created.
 *
 * Used in `conversations:sent` events.
 * @type {String}
 * @static
 */
Container.FOUND = 'Found';

/**
 * The Conversation/Channel that was requested has been found, but there was a mismatch in metadata.
 *
 * If the createConversation request contained metadata and it did not match the Distinct Conversation
 * that matched the requested participants, then this value is passed to notify your app that the Conversation
 * was returned but does not exactly match your request.
 *
 * Used in `conversations:sent` events.
 * @type {String}
 * @static
 */
Container.FOUND_WITHOUT_REQUESTED_METADATA = 'FoundMismatch';


Root.initClass.apply(Container, [Container, 'Container']);
Syncable.subclasses.push(Container);
module.exports = Container;
