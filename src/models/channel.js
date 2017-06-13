/**
 * A Channel object represents a dialog amongst a large set
 * of participants.
 *
 * ```
 * var channel = client.createChannel({
 *   name: "frodo-the-dodo",
 *   members: ["layer:///identities/samwise", "layer:///identities/orc-army"],
 *   metadata: {
 *     subtopic: "Sauruman is the man.  And a Saurian",
 *     tooMuchInfo: {
 *       nose: "stuffed"
 *     }
 *   }
 * });
 *
 * channel.createMessage("Please don't eat me").send();
 * ```
 * NOTE: Sending a Message creates the Channel; this avoids having lots of unused channels being created.
 *
 * Key methods, events and properties for getting started:
 *
 * Properties:
 *
 * * layer.Channel.id: this property is worth being familiar with; it identifies the
 *   Channel and can be used in `client.getChannel(id)` to retrieve it.
 * * layer.Channel.name: this property names the channel; this may be human readable, though for localization purposes,
 *   you may instead want to use a common name that is distinct from your displayed name.  There can only be a single
 *   channel with a given name per app.
 * * layer.Channel.membership: Contains status information about your user's role in this Channel.
 * * layer.Channel.isCurrentParticipant: Shorthand for determining if your user is a member of the Channel.
 *
 * Methods:
 *
 * * layer.Channel.join() to join the Channel
 * * layer.Channel.leave() to leave the Channel
 * * layer.Channel.on() and layer.Channel.off(): event listeners built on top of the `backbone-events-standalone` npm project
 * * layer.Channel.createMessage() to send a message on the Channel.
 *
 * Events:
 *
 * * `channels:change`: Useful for observing changes to Channel name
 *   and updating rendering of your Channel
 *
 * Finally, to access a list of Messages in a Channel, see layer.Query.
 *
 * @class  layer.Channel
 * @experimental This feature is incomplete, and available as Preview only.
 * @extends layer.Container
 * @author  Michael Kantor
 */
const Root = require('../root');
const Syncable = require('./syncable');
const Container = require('./container');
const ChannelMessage = require('./channel-message');
const LayerError = require('../layer-error');
const LayerEvent = require('../layer-event');
const Util = require('../client-utils');
const Constants = require('../const');

class Channel extends Container {
  constructor(options = {}) {
    // Setup default values
    if (!options.membership) options.membership = {};
    super(options);
    this._members = this.getClient()._fixIdentities(options.members || []).map(item => item.id);
    this._register();
  }

  /**
   * Destroy the local copy of this Channel, cleaning up all resources
   * it consumes.
   *
   * @method destroy
   */
  destroy() {
    this.lastMessage = null;
    this.getClient()._removeChannel(this);
    super.destroy();
    this.membership = null;
  }

  /**
   * Create a new layer.Message.ChannelMessage instance within this conversation
   *
   *      var message = channel.createMessage('hello');
   *
   *      var message = channel.createMessage({
   *          parts: [new layer.MessagePart({
   *                      body: 'hello',
   *                      mimeType: 'text/plain'
   *                  })]
   *      });
   *
   * See layer.Message.ChannelMessage for more options for creating the message.
   *
   * @method createMessage
   * @param  {String|Object} options - If its a string, a MessagePart is created around that string.
   * @param {layer.MessagePart[]} options.parts - An array of MessageParts.  There is some tolerance for
   *                                               it not being an array, or for it being a string to be turned
   *                                               into a MessagePart.
   * @return {layer.Message.ChannelMessage}
   */
  createMessage(options = {}) {
    const messageConfig = (typeof options === 'string') ? {
      parts: [{ body: options, mimeType: 'text/plain' }],
    } : options;
    messageConfig.clientId = this.clientId;
    messageConfig.conversationId = this.id;
    messageConfig._loadType = 'websocket'; // treat this the same as a websocket loaded object

    return new ChannelMessage(messageConfig);
  }

  _setupMessage(message) {
    message.position = Channel.nextPosition;
    Channel.nextPosition += 8192;
  }

  /**
   * Gets the data for a Create request.
   *
   * The layer.SyncManager needs a callback to create the Conversation as it
   * looks NOW, not back when `send()` was called.  This method is called
   * by the layer.SyncManager to populate the POST data of the call.
   *
   * @method _getSendData
   * @private
   * @return {Object} Websocket data for the request
   */
  _getSendData(data) {
    const isMetadataEmpty = Util.isEmpty(this.metadata);
    const members = this._members || [];
    if (members.indexOf(this.getClient().user.id) === -1) members.push(this.getClient().user.id);
    return {
      method: 'Channel.create',
      data: {
        name: this.name,
        metadata: isMetadataEmpty ? null : this.metadata,
        id: this.id,
        members,
      },
    };
  }


  _populateFromServer(channel) {
    this._inPopulateFromServer = true;

    // Disable events if creating a new Conversation
    // We still want property change events for anything that DOES change
    this._disableEvents = (this.syncState === Constants.SYNC_STATE.NEW);
    this.name = channel.name;

    this.isCurrentParticipant = Boolean(channel.membership);
    this.membership = !channel.membership ||
      !channel.membership.id ? null : this.getClient()._createObject(channel.membership);

    super._populateFromServer(channel);
    this._register();

    this._disableEvents = false;
  }

  _createResultConflict(data) {
    const channel = data.data;
    if (channel) {
      this._createSuccess(channel);
    } else {
      this.syncState = Constants.SYNC_STATE.NEW;
      this._syncCounter = 0;
      this.trigger('channels:sent-error', { error: data });
    }

    this._inPopulateFromServer = false;
  }

  __adjustName(newValue) {
    if (this._inPopulateFromServer || this._inLayerParser || this.isNew() || this.isLoading) return;
    throw new Error(LayerError.dictionary.permissionDenied);
  }

  /**
   * __ Methods are automatically called by property setters.
   *
   * Any change in the name property will call this method and fire a
   * change event.
   *
   * @method __updateName
   * @private
   * @param  {string} newValue
   * @param  {string} oldValue
   */
  __updateName(newValue, oldValue) {
    this._triggerAsync('channels:change', {
      property: 'name',
      oldValue,
      newValue,
    });
  }

  /**
   * Add the following members to the Channel.
   *
   * Unlike Conversations, Channels do not maintain state information about their members.
   * As such, if the operation fails there is no actual state change
   * for the channel.  Currently the only errors exposed are from the layer.Client.SyncManager.
   *
   * @method addMembers
   * @param {String[]} members   Identity IDs of users to add to this Channel
   * @return {layer.Channel} this
   *
   *
   *
   *
   *
   * @ignore until server supports it
   */
  addMembers(members) {
    members = this.getClient()._fixIdentities(members).map(item => item.id);
    if (this.syncState === Constants.SYNC_STATE.NEW) {
      this._members = this._members.concat(members);
      return this;
    }

    // TODO: Should use the bulk operation when it becomes available.
    members.forEach((identityId) => {
      this._xhr({
        url: '/members/' + identityId.replace(/^layer:\/\/\/identities\//, ''),
        method: 'PUT',
      });
    });
    return this;
  }

  /**
   * Remove the following members from the Channel.
   *
   * Not yet supported.
   *
   * @method removeMembers
   * @param {String[]} members   Identity IDs of users to remove from this Channel
   * @return {layer.Channel} this
   *
   *
   *
   *
   *
   * @ignore until server supports it
   */
  removeMembers(members) {
    members = this.getClient()._fixIdentities(members).map(item => item.id);

    if (this.syncState === Constants.SYNC_STATE.NEW) {
      members.forEach((id) => {
        const index = this._members.indexOf(id);
        if (index !== -1) this._members.splice(index, 1);
      });
      return this;
    }

    // TODO: Should use the bulk operation when it becomes available.
    members.forEach((identityId) => {
      this._xhr({
        url: '/members/' + identityId.replace(/^layer:\/\/\/identities\//, ''),
        method: 'DELETE',
      });
    });
    return this;
  }

  /**
   * Add the current user to this channel.
   *
   * @method join
   * @return {layer.Channel} this
   *
   *
   *
   *
   *
   * @ignore until server supports it
   */
  join() {
    return this.addMembers([this.getClient().user.id]);
  }

  /**
   * remove the current user from this channel.
   *
   * @method leave
   * @return {layer.Channel} this
   *
   *
   *
   *
   * @ignore until server supports it
   */
  leave() {
    return this.removeMembers([this.getClient().user.id]);
  }

  /**
   * Return a Membership object for the specified Identity ID.
   *
   * If `members:loaded` is triggered, then your membership object
   * has been populated with data.
   *
   * If `members:loaded-error` is triggered, then your membership object
   * could not be loaded, either you have a connection error, or the user is not a member.
   *
   * ```
   * var membership = channel.getMember('FrodoTheDodo');
   * membership.on('membership:loaded', function(evt) {
   *    alert('He IS a member, quick, kick him out!');
   * });
   * membership.on('membership:loaded-error', function(evt) {
   *    if (evt.error.id === 'not_found') {
   *      alert('Sauruman, he is with the Elves!');
   *    } else {
   *      alert('Sauruman, would you please pick up your Palantir already? I can't connect!');
   *    }
   * });
   * ```
   * @method getMember
   * @param {String} identityId
   * @returns {layer.Membership}
   */
  getMember(identityId) {
    identityId = this.getClient()._fixIdentities([identityId])[0].id;
    const membershipId = this.id + '/members/' + identityId.replace(/layer:\/\/\/identities\//, '');
    return this.getClient().getMember(membershipId, true);
  }

  /**
   * Delete the channel; not currently supported.
   *
   * @method delete
   */
  delete() {
    this._delete('');
  }

  /**
   * LayerPatch will call this after changing any properties.
   *
   * Trigger any cleanup or events needed after these changes.
   *
   * TODO: Move this to layer.Container
   *
   * @method _handlePatchEvent
   * @private
   * @param  {Mixed} newValue - New value of the property
   * @param  {Mixed} oldValue - Prior value of the property
   * @param  {string[]} paths - Array of paths specifically modified: ['participants'], ['metadata.keyA', 'metadata.keyB']
   */
  _handlePatchEvent(newValue, oldValue, paths) {
    // Certain types of __update handlers are disabled while values are being set by
    // layer patch parser because the difference between setting a value (triggers an event)
    // and change a property of a value (triggers only this callback) result in inconsistent
    // behaviors.  Enable them long enough to allow __update calls to be made
    this._inLayerParser = false;
    try {
      const events = this._disableEvents;
      this._disableEvents = false;
      super._handlePatchEvent(newValue, oldValue, paths);
      this._disableEvents = events;
    } catch (err) {
      // do nothing
    }
    this._inLayerParser = true;
  }

  /**
   * Register this Channel with the Client
   *
   * @method _register
   * @private
   */
  _register() {
    const client = this.getClient();
    client._addChannel(this);
  }

  _deleteResult(result, id) {
    const client = this.getClient();
    if (!result.success && (!result.data || (result.data.id !== 'not_found' && result.data.id !== 'authentication_required'))) {
      Channel.load(id, client);
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
      this._toObject.membership = Util.clone(this.membership);
    }
    return this._toObject;
  }

  /**
   * Create a channel instance from a server representation of the channel.
   *
   * If the Channel already exists, will update the existing copy with
   * presumably newer values.
   *
   * @method _createFromServer
   * @protected
   * @static
   * @param  {Object} channel - Server representation of a Channel
   * @param  {layer.Client} client
   * @return {layer.Channel}
   */
  static _createFromServer(channel, client) {
    return new Channel({
      client,
      fromServer: channel,
      _fromDB: channel._fromDB,
    });
  }

  /**
   * Find or create a new Channel.
   *
   *      var channel = layer.Channel.create({
   *          members: ['a', 'b'],
   *          private: true,
   *          metadata: {
   *              titleDetails: 'I am not a detail!'
   *          },
   *          client: client,
   *          'channels:loaded': function(evt) {
   *
   *          }
   *      });
   *
   * Recommend using `client.createChannel({...})`
   * instead of `Channel.create({...})`.
   *
   * @method create
   * @static
   * @protected
   * @param  {Object} options
   * @param  {layer.Client} options.client
   * @param  {string[]/layer.Identity[]} options.members - Array of Participant IDs or layer.Identity objects to create a channel with.
   * @param {boolean} [options.private=false] - Create a private channel
   * @param {Object} [options.metadata={}] - Initial metadata for Channel
   * @return {layer.Channel}
   */
  static create(options) {
    if (!options.client) throw new Error(LayerError.dictionary.clientMissing);
    if (!options.name) options.name = 'channel-' + String(Math.random()).replace(/\./, '');
    const newOptions = {
      name: options.name,
      private: options.private,
      members: options.members ? options.client._fixIdentities(options.members).map(item => item.id) : [],
      metadata: options.metadata,
      client: options.client,
    };

    const channel = options.client.findCachedChannel(aChannel => aChannel.name === newOptions.name);

    if (channel) {
      channel._sendDistinctEvent = new LayerEvent({
        target: channel,
        result: !options.metadata || Util.doesObjectMatch(options.metadata, channel.metadata) ?
          Channel.FOUND : Channel.FOUND_WITHOUT_REQUESTED_METADATA,
      }, 'channels:sent');
    }

    return channel || new Channel(newOptions);
  }
}

/**
 * The Channel's name; this must be unique.
 *
 * Note that while you can use a displayable human readable name, you may also choose to use this
 * as an ID that you can easily localize to different languages.
 *
 * Must not be a UUID.
 *
 * @property {String} name
 */
Channel.prototype.name = '';

/**
 * The `membership` object contains details of this user's membership within this channel.
 *
 * NOTE: Initially, only `isMember` will be available.
 *
 * ```
 * {
 *     "isMember": true,
 *     "role": "user",
 *     "lastUnreadMessageId: "layer:///messages/UUID"
 * }
 * ```
 * @property {Object}
 */
Channel.prototype.membership = null;

Channel.prototype._members = null;

Channel.eventPrefix = 'channels';

// Math.pow(2, 64); a number larger than Number.MAX_SAFE_INTEGER, and larger than Java's Max Unsigned Long. And an easy to work with
// factor of 2
Channel.nextPosition = 18446744073709552000;

/**
 * Prefix to use when generating an ID for instances of this class
 * @type {String}
 * @static
 * @private
 */
Channel.prefixUUID = 'layer:///channels/';

Channel._supportedEvents = [

  /**
   * The conversation is now on the server.
   *
   * Called after successfully creating the conversation
   * on the server.  The Result property is one of:
   *
   * * Channel.CREATED: A new Channel has been created
   * * Channel.FOUND: A matching named Channel has been found
   *
   * @event
   * @param {layer.LayerEvent} event
   * @param {string} event.result
   */
  'channels:sent',

  /**
   * An attempt to send this channel to the server has failed.
   * @event
   * @param {layer.LayerEvent} event
   * @param {layer.LayerError} event.error
   */
  'channels:sent-error',

  /**
   * The conversation is now loaded from the server.
   *
   * Note that this is only used in response to the layer.Channel.load() method.
   * from the server.
   * @event
   * @param {layer.LayerEvent} event
   */
  'channels:loaded',

  /**
   * An attempt to load this conversation from the server has failed.
   *
   * Note that this is only used in response to the layer.Channel.load() method.
   * @event
   * @param {layer.LayerEvent} event
   * @param {layer.LayerError} event.error
   */
  'channels:loaded-error',

  /**
   * The conversation has been deleted from the server.
   *
   * Caused by either a successful call to delete() on this instance
   * or by a remote user.
   * @event
   * @param {layer.LayerEvent} event
   */
  'channels:delete',

  /**
   * This channel has changed.
   *
   * @event
   * @param {layer.LayerEvent} event
   * @param {Object[]} event.changes - Array of changes reported by this event
   * @param {Mixed} event.changes.newValue
   * @param {Mixed} event.changes.oldValue
   * @param {string} event.changes.property - Name of the property that changed
   * @param {layer.Conversation} event.target
   */
  'channels:change'].concat(Syncable._supportedEvents);


Root.initClass.apply(Channel, [Channel, 'Channel']);
Syncable.subclasses.push(Channel);
module.exports = Channel;
