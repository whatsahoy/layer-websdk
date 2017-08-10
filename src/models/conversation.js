/**
 * A Conversation object represents a dialog amongst a small set
 * of participants.
 *
 * Create a Conversation using the client:
 *
 *      var conversation = client.createConversation({
 *          participants: ['a','b'],
 *          distinct: true
 *      });
 *
 * NOTE:   Do not create a conversation with new layer.Conversation(...),
 *         This will fail to handle the distinct property short of going to the server for evaluation.
 *
 * NOTE:   Creating a Conversation is a local action.  A Conversation will not be
 *         sent to the server until either:
 *
 * 1. A message is sent on that Conversation
 * 2. `Conversation.send()` is called (not recommended as mobile clients
 *    expect at least one layer.Message.ConversationMessage in a Conversation)
 *
 * Key methods, events and properties for getting started:
 *
 * Properties:
 *
 * * layer.Conversation.id: this property is worth being familiar with; it identifies the
 *   Conversation and can be used in `client.getConversation(id)` to retrieve it.
 * * layer.Conversation.lastMessage: This property makes it easy to show info about the most recent Message
 *    when rendering a list of Conversations.
 * * layer.Conversation.metadata: Custom data for your Conversation; commonly used to store a 'title' property
 *    to name your Conversation.
 *
 * Methods:
 *
 * * layer.Conversation.addParticipants and layer.Conversation.removeParticipants: Change the participants of the Conversation
 * * layer.Conversation.setMetadataProperties: Set metadata.title to 'My Conversation with Layer Support' (uh oh)
 * * layer.Conversation.on() and layer.Conversation.off(): event listeners built on top of the `backbone-events-standalone` npm project
 * * layer.Conversation.leave() to leave the Conversation
 * * layer.Conversation.delete() to delete the Conversation for all users (or for just this user)
 *
 * Events:
 *
 * * `conversations:change`: Useful for observing changes to participants and metadata
 *   and updating rendering of your open Conversation
 *
 * Finally, to access a list of Messages in a Conversation, see layer.Query.
 *
 * @class  layer.Conversation
 * @extends layer.Container
 * @author  Michael Kantor
 */

const Root = require('../root');
const Syncable = require('./syncable');
const Container = require('./container');
const ConversationMessage = require('./conversation-message');
const LayerError = require('../layer-error');
const Util = require('../client-utils');
const Constants = require('../const');
const LayerEvent = require('../layer-event');
const logger = require('../logger');

class Conversation extends Container {
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
    // Setup default values
    if (!options.participants) options.participants = [];
    super(options);
    this.isInitializing = true;
    const client = this.getClient();

    // If the options doesn't contain server object, setup participants.
    if (!options || !options.fromServer) {
      this.participants = client._fixIdentities(this.participants);
      if (this.participants.indexOf(client.user) === -1) {
        this.participants.push(client.user);
      }
    }
    this._register();
    this.isInitializing = false;
  }

  /**
   * Destroy the local copy of this Conversation, cleaning up all resources
   * it consumes.
   *
   * @method destroy
   */
  destroy() {
    this.lastMessage = null;

    // Client fires 'conversations:remove' and then removes the Conversation.
    if (this.clientId) this.getClient()._removeConversation(this);

    super.destroy();

    this.participants = null;
    this.metadata = null;
  }

  /**
   * Create a new layer.Message.ConversationMessage instance within this conversation
   *
   *      var message = conversation.createMessage('hello');
   *
   *      var message = conversation.createMessage({
   *          parts: [new layer.MessagePart({
   *                      body: 'hello',
   *                      mimeType: 'text/plain'
   *                  })]
   *      });
   *
   * See layer.Message.ConversationMessage for more options for creating the message.
   *
   * @method createMessage
   * @param  {String|Object} options - If its a string, a MessagePart is created around that string.
   * @param {layer.MessagePart[]} options.parts - An array of MessageParts.  There is some tolerance for
   *                                               it not being an array, or for it being a string to be turned
   *                                               into a MessagePart.
   * @return {layer.Message.ConversationMessage}
   */
  createMessage(options = {}) {
    const messageConfig = (typeof options === 'string') ? {
      parts: [{ body: options, mimeType: 'text/plain' }],
    } : options;
    messageConfig.clientId = this.clientId;
    messageConfig.conversationId = this.id;

    return new ConversationMessage(messageConfig);
  }


  _setupMessage(message) {
    // Setting a position is required if its going to get sorted correctly by query.
    // The correct position will be written by _populateFromServer when the object
    // is returned from the server.
    // NOTE: We have a special case where messages are sent from multiple tabs, written to indexedDB, but not yet sent,
    // they will have conflicting positions.
    // Attempts to fix this by offsetting the position by time resulted in unexpected behaviors
    // as multiple messages end up with positions greater than returned by the server.
    let position;
    if (this.lastMessage) {
      position = this.lastMessage.position + 1;
    } else if (this._lastMessagePosition) {
      position = this._lastMessagePosition + 1;
      this._lastMessagePosition = 0;
    } else {
      position = 0;
    }
    message.position = position;
    this.lastMessage = message;
  }

  /**
   * Create this Conversation on the server.
   *
   * On completion, this instance will receive
   * an id, url and createdAt.  It may also receive metadata
   * if there was a FOUND_WITHOUT_REQUESTED_METADATA result.
   *
   * Note that the optional Message parameter should NOT be used except
   * by the layer.Message.ConversationMessage class itself.
   *
   * Note that recommended practice is to send the Conversation by sending a Message in the Conversation,
   * and NOT by calling Conversation.send.
   *
   *      client.createConversation({
   *          participants: ['a', 'b'],
   *          distinct: false
   *      })
   *      .send()
   *      .on('conversations:sent', function(evt) {
   *          alert('Done');
   *      });
   *
   * @method send
   * @param {layer.Message.ConversationMessage} [message] Tells the Conversation what its last_message will be
   * @return {layer.Conversation} this
   */
  send(message) {
    const client = this.getClient();
    if (!client) throw new Error(LayerError.dictionary.clientMissing);

    // If this is part of a create({distinct:true}).send() call where
    // the distinct conversation was found, just trigger the cached event and exit
    const wasLocalDistinct = Boolean(this._sendDistinctEvent);
    if (this._sendDistinctEvent) this._handleLocalDistinctConversation();

    // If the Conversation is already on the server, don't send.
    if (wasLocalDistinct || this.syncState !== Constants.SYNC_STATE.NEW) {
      if (message) this._setupMessage(message);
      return this;
    }

    // Make sure this user is a participant (server does this for us, but
    // this insures the local copy is correct until we get a response from
    // the server
    if (this.participants.indexOf(client.user) === -1) {
      this.participants.push(client.user);
    }

    return super.send(message);
  }

  /**
   * Handles the case where a Distinct Create Conversation found a local match.
   *
   * When an app calls client.createConversation([...])
   * and requests a Distinct Conversation (default setting),
   * and the Conversation already exists, what do we do to help
   * them access it?
   *
   *      client.createConversation(["fred"]).on("conversations:sent", function(evt) {
   *        render();
   *      });
   *
   * Under normal conditions, calling `c.send()` on a matching distinct Conversation
   * would either throw an error or just be a no-op.  We use this method to trigger
   * the expected "conversations:sent" event even though its already been sent and
   * we did nothing.  Use the evt.result property if you want to know whether the
   * result was a new conversation or matching one.
   *
   * @method _handleLocalDistinctConversation
   * @private
   */
  _handleLocalDistinctConversation() {
    const evt = this._sendDistinctEvent;
    this._sendDistinctEvent = null;

    // delay so there is time to setup an event listener on this conversation
    this._triggerAsync('conversations:sent', evt);
    return this;
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
    return {
      method: 'Conversation.create',
      data: {
        participants: this.participants.map(identity => identity.id),
        distinct: this.distinct,
        metadata: isMetadataEmpty ? null : this.metadata,
        id: this.id,
      },
    };
  }

  /**
   * Mark all messages in the conversation as read.
   *
   * Optionally provide a Message object to mark all messages up to and including
   * the specified message as read.
   *
   * Will not update `message.isRead` nor `conversation.unreadCount` until after
   * server has responded to the request.
   *
   * ```
   * conversation.markAllMessagesAsRead();
   * ```
   *
   * @method markAllMessagesAsRead
   * @param {layer.Message} [message=conversation.lastMessage]
   * @return this
   */
  markAllMessagesAsRead(message) {
    if (!this.isSaved()) return this;
    if (!message) message = this.lastMessage;
    const position = (!message || !message.isSaved()) ? null : message.position;
    this._xhr({
      method: 'POST',
      url: '/mark_all_read',
      data: { position },
      sync: {
        operation: 'RECEIPT',
      },
    }, (result) => {
      if (!result.success) {
        logger.error('Mark all as read failed; currently this error is not handled by Layer WebSDK');
      }
    });
    return this;
  }

  _populateFromServer(conversation) {
    const client = this.getClient();

    // Disable events if creating a new Conversation
    // We still want property change events for anything that DOES change
    this._disableEvents = (this.syncState === Constants.SYNC_STATE.NEW);

    this.participants = client._fixIdentities(conversation.participants);
    this.participants.forEach(identity => identity.on('identities:change', this._handleParticipantChangeEvent, this));
    this.distinct = conversation.distinct;
    this.totalMessageCount = conversation.total_message_count;
    this.unreadCount = conversation.unread_message_count;
    this.totalMessageCount = conversation.total_message_count;
    this.isCurrentParticipant = this.participants.indexOf(client.user) !== -1;
    super._populateFromServer(conversation);

    if (typeof conversation.last_message === 'string') {
      this.lastMessage = client.getMessage(conversation.last_message);
    } else if (conversation.last_message) {
      this.lastMessage = client._createObject(conversation.last_message);
    }
    this._register();

    this._disableEvents = false;
  }

  _createResultConflict(data) {
    this._populateFromServer(data.data);
    this._triggerAsync(this.constructor.eventPrefix + ':sent', {
      result: Conversation.FOUND_WITHOUT_REQUESTED_METADATA,
    });
  }

  /**
   * Add an array of participant ids to the conversation.
   *
   *      conversation.addParticipants(['a', 'b']);
   *
   * New participants will immediately show up in the Conversation,
   * but may not have synced with the server yet.
   *
   * TODO WEB-967: Roll participants back on getting a server error
   *
   * @method addParticipants
   * @param  {string[]/layer.Identity[]} participants - Array of Participant IDs or Identity objects
   * @returns {layer.Conversation} this
   */
  addParticipants(participants) {
    // Only add those that aren't already in the list.
    const client = this.getClient();
    const identities = client._fixIdentities(participants);
    const adding = identities.filter(identity => this.participants.indexOf(identity) === -1);
    this._patchParticipants({ add: adding, remove: [] });
    return this;
  }

  /**
   * Removes an array of participant ids from the conversation.
   *
   *      conversation.removeParticipants(['a', 'b']);
   *
   * Removed participants will immediately be removed from this Conversation,
   * but may not have synced with the server yet.
   *
   * Throws error if you attempt to remove ALL participants.
   *
   * TODO  WEB-967: Roll participants back on getting a server error
   *
   * @method removeParticipants
   * @param  {string[]/layer.Identity[]} participants - Array of Participant IDs or Identity objects
   * @returns {layer.Conversation} this
   */
  removeParticipants(participants) {
    const currentParticipants = {};
    this.participants.forEach(participant => (currentParticipants[participant.id] = true));
    const client = this.getClient();
    const identities = client._fixIdentities(participants);

    const removing = identities.filter(participant => currentParticipants[participant.id]);
    if (removing.length === 0) return this;
    if (removing.length === this.participants.length) {
      throw new Error(LayerError.dictionary.moreParticipantsRequired);
    }
    this._patchParticipants({ add: [], remove: removing });
    return this;
  }

  /**
   * Replaces all participants with a new array of of participant ids.
   *
   *      conversation.replaceParticipants(['a', 'b']);
   *
   * Changed participants will immediately show up in the Conversation,
   * but may not have synced with the server yet.
   *
   * TODO WEB-967: Roll participants back on getting a server error
   *
   * @method replaceParticipants
   * @param  {string[]/layer.Identity[]} participants - Array of Participant IDs or Identity objects
   * @returns {layer.Conversation} this
   */
  replaceParticipants(participants) {
    if (!participants || !participants.length) {
      throw new Error(LayerError.dictionary.moreParticipantsRequired);
    }

    const client = this.getClient();
    const identities = client._fixIdentities(participants);

    const change = this._getParticipantChange(identities, this.participants);
    this._patchParticipants(change);
    return this;
  }

  /**
   * Update the server with the new participant list.
   *
   * Executes as follows:
   *
   * 1. Updates the participants property of the local object
   * 2. Triggers a conversations:change event
   * 3. Submits a request to be sent to the server to update the server's object
   * 4. If there is an error, no errors are fired except by layer.SyncManager, but another
   *    conversations:change event is fired as the change is rolled back.
   *
   * @method _patchParticipants
   * @private
   * @param  {Object[]} operations - Array of JSON patch operation
   * @param  {Object} eventData - Data describing the change for use in an event
   */
  _patchParticipants(change) {
    this._applyParticipantChange(change);
    this.isCurrentParticipant = this.participants.indexOf(this.getClient().user) !== -1;

    const ops = [];
    change.remove.forEach((participant) => {
      ops.push({
        operation: 'remove',
        property: 'participants',
        id: participant.id,
      });
    });

    change.add.forEach((participant) => {
      ops.push({
        operation: 'add',
        property: 'participants',
        id: participant.id,
      });
    });

    this._xhr({
      url: '',
      method: 'PATCH',
      data: JSON.stringify(ops),
      headers: {
        'content-type': 'application/vnd.layer-patch+json',
      },
    }, (result) => {
      if (!result.success && result.data.id !== 'authentication_required') this._load();
    });
  }

  /**
   * Internally we use `{add: [], remove: []}` instead of LayerOperations.
   *
   * So control is handed off to this method to actually apply the changes
   * to the participants array.
   *
   * @method _applyParticipantChange
   * @private
   * @param  {Object} change
   * @param  {layer.Identity[]} change.add - Array of userids to add
   * @param  {layer.Identity[]} change.remove - Array of userids to remove
   */
  _applyParticipantChange(change) {
    const participants = [].concat(this.participants);
    change.add.forEach((participant) => {
      if (participants.indexOf(participant) === -1) participants.push(participant);
    });
    change.remove.forEach((participant) => {
      const index = participants.indexOf(participant);
      if (index !== -1) participants.splice(index, 1);
    });
    this.participants = participants;
  }

  /**
   * Delete the Conversation from the server and removes this user as a participant.
   *
   * @method leave
   */
  leave() {
    if (this.isDestroyed) throw new Error(LayerError.dictionary.isDestroyed);
    this._delete(`mode=${Constants.DELETION_MODE.MY_DEVICES}&leave=true`);
  }

  /**
   * Delete the Conversation from the server, but deletion mode may cause user to remain a participant.
   *
   * This call will support various deletion modes.
   *
   * Deletion Modes:
   *
   * * layer.Constants.DELETION_MODE.ALL: This deletes the local copy immediately, and attempts to also
   *   delete the server's copy.
   * * layer.Constants.DELETION_MODE.MY_DEVICES: Deletes the local copy immediately, and attempts to delete it from all
   *   of my devices.  Other users retain access.
   * * true: For backwards compatibility thi is the same as ALL.
   *
   * MY_DEVICES does not remove this user as a participant.  That means a new Message on this Conversation will recreate the
   * Conversation for this user.  See layer.Conversation.leave() instead.
   *
   * Executes as follows:
   *
   * 1. Submits a request to be sent to the server to delete the server's object
   * 2. Delete's the local object
   * 3. If there is an error, no errors are fired except by layer.SyncManager, but the Conversation will be reloaded from the server,
   *    triggering a conversations:add event.
   *
   * @method delete
   * @param {String} deletionMode
   */
  delete(mode) {
    if (this.isDestroyed) throw new Error(LayerError.dictionary.isDestroyed);

    let queryStr;
    switch (mode) {
      case Constants.DELETION_MODE.ALL:
      case true:
        queryStr = `mode=${Constants.DELETION_MODE.ALL}`;
        break;
      case Constants.DELETION_MODE.MY_DEVICES:
        queryStr = `mode=${Constants.DELETION_MODE.MY_DEVICES}&leave=false`;
        break;
      default:
        throw new Error(LayerError.dictionary.deletionModeUnsupported);
    }

    this._delete(queryStr);
  }

  /**
   * LayerPatch will call this after changing any properties.
   *
   * Trigger any cleanup or events needed after these changes.
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
      if (paths[0] === 'participants') {
        const client = this.getClient();
        // oldValue/newValue come as a Basic Identity POJO; lets deliver events with actual instances
        oldValue = oldValue.map(identity => client.getIdentity(identity.id));
        newValue = newValue.map(identity => client.getIdentity(identity.id));
        this.__updateParticipants(newValue, oldValue);
      } else {
        super._handlePatchEvent(newValue, oldValue, paths);
      }
      this._disableEvents = events;
    } catch (err) {
      // do nothing
    }
    this._inLayerParser = true;
  }

  /**
   * Given the oldValue and newValue for participants,
   * generate a list of whom was added and whom was removed.
   *
   * @method _getParticipantChange
   * @private
   * @param  {layer.Identity[]} newValue
   * @param  {layer.Identity[]} oldValue
   * @return {Object} Returns changes in the form of `{add: [...], remove: [...]}`
   */
  _getParticipantChange(newValue, oldValue) {
    const change = {};
    change.add = newValue.filter(participant => oldValue.indexOf(participant) === -1);
    change.remove = oldValue.filter(participant => newValue.indexOf(participant) === -1);
    return change;
  }


  _deleteResult(result, id) {
    const client = this.getClient();
    if (!result.success && (!result.data || (result.data.id !== 'not_found' && result.data.id !== 'authentication_required'))) {
      Conversation.load(id, client);
    }
  }


  _register() {
    const client = this.getClient();
    if (client) client._addConversation(this);
  }


  /*
   * Insure that conversation.unreadCount-- can never reduce the value to negative values.
   */
  __adjustUnreadCount(newValue) {
    if (newValue < 0) return 0;
  }

  /**
   * __ Methods are automatically called by property setters.
   *
   * Any change in the unreadCount property will call this method and fire a
   * change event.
   *
   * Any triggering of this from a websocket patch unread_message_count should wait a second before firing any events
   * so that if there are a series of these updates, we don't see a lot of jitter.
   *
   * NOTE: _oldUnreadCount is used to pass data to _updateUnreadCountEvent because this method can be called many times
   * a second, and we only want to trigger this with a summary of changes rather than each individual change.
   *
   * @method __updateUnreadCount
   * @private
   * @param  {number} newValue
   * @param  {number} oldValue
   */
  __updateUnreadCount(newValue, oldValue) {
    if (this._inLayerParser) {
      if (this._oldUnreadCount === undefined) this._oldUnreadCount = oldValue;
      if (this._updateUnreadCountTimeout) clearTimeout(this._updateUnreadCountTimeout);
      this._updateUnreadCountTimeout = setTimeout(() => this._updateUnreadCountEvent(), 1000);
    } else {
      this._updateUnreadCountEvent();
    }
  }

  /**
   * Fire events related to changes to unreadCount
   *
   * @method _updateUnreadCountEvent
   * @private
   */
  _updateUnreadCountEvent() {
    if (this.isDestroyed) return;
    const oldValue = this._oldUnreadCount;
    const newValue = this.__unreadCount;
    this._oldUnreadCount = undefined;

    if (newValue === oldValue) return;
    this._triggerAsync('conversations:change', {
      newValue,
      oldValue,
      property: 'unreadCount',
    });
  }

  /**
   * __ Methods are automatically called by property setters.
   *
   * Any change in the lastMessage pointer will call this method and fire a
   * change event.  Changes to properties within the lastMessage object will
   * not trigger this call.
   *
   * @method __updateLastMessage
   * @private
   * @param  {layer.Message.ConversationMessage} newValue
   * @param  {layer.Message.ConversationMessage} oldValue
   */
  __updateLastMessage(newValue, oldValue) {
    if (newValue && oldValue && newValue.id === oldValue.id) return;
    this._triggerAsync('conversations:change', {
      property: 'lastMessage',
      newValue,
      oldValue,
    });
  }

  /**
   * __ Methods are automatically called by property setters.
   *
   * Any change in the participants property will call this method and fire a
   * change event.  Changes to the participants array that don't replace the array
   * with a new array will require directly calling this method.
   *
   * @method __updateParticipants
   * @private
   * @param  {string[]} newValue
   * @param  {string[]} oldValue
   */
  __updateParticipants(newValue, oldValue) {
    if (this._inLayerParser) return;
    const change = this._getParticipantChange(newValue, oldValue);
    change.add.forEach(identity => identity.on('identities:change', this._handleParticipantChangeEvent, this));
    change.remove.forEach(identity => identity.off('identities:change', this._handleParticipantChangeEvent, this));
    if (change.add.length || change.remove.length) {
      change.property = 'participants';
      change.oldValue = oldValue;
      change.newValue = newValue;
      this._triggerAsync('conversations:change', change);
    }
  }

  _handleParticipantChangeEvent(evt) {
    evt.changes.forEach((change) => {
      this._triggerAsync('conversations:change', {
        property: 'participants.' + change.property,
        identity: evt.target,
        oldValue: change.oldValue,
        newValue: change.newValue,
      });
    });
  }

  /**
   * Create a conversation instance from a server representation of the conversation.
   *
   * If the Conversation already exists, will update the existing copy with
   * presumably newer values.
   *
   * @method _createFromServer
   * @protected
   * @static
   * @param  {Object} conversation - Server representation of a Conversation
   * @param  {layer.Client} client
   * @return {layer.Conversation}
   */
  static _createFromServer(conversation, client) {
    return new Conversation({
      client,
      fromServer: conversation,
      _fromDB: conversation._fromDB,
    });
  }

  /**
   * Find or create a new conversation.
   *
   *      var conversation = layer.Conversation.create({
   *          participants: ['a', 'b'],
   *          distinct: true,
   *          metadata: {
   *              title: 'I am not a title!'
   *          },
   *          client: client,
   *          'conversations:loaded': function(evt) {
   *
   *          }
   *      });
   *
   * Only tries to find a Conversation if its a Distinct Conversation.
   * Distinct defaults to true.
   *
   * Recommend using `client.createConversation({...})`
   * instead of `Conversation.create({...})`.
   *
   * @method create
   * @static
   * @protected
   * @param  {Object} options
   * @param  {layer.Client} options.client
   * @param  {string[]/layer.Identity[]} options.participants - Array of Participant IDs or layer.Identity objects to create a conversation with.
   * @param {boolean} [options.distinct=true] - Create a distinct conversation
   * @param {Object} [options.metadata={}] - Initial metadata for Conversation
   * @return {layer.Conversation}
   */
  static create(options) {
    if (!options.client) throw new Error(LayerError.dictionary.clientMissing);
    const newOptions = {
      distinct: options.distinct,
      participants: options.client._fixIdentities(options.participants),
      metadata: options.metadata,
      client: options.client,
    };
    if (newOptions.distinct) {
      const conv = this._createDistinct(newOptions);
      if (conv) return conv;
    }
    return new Conversation(newOptions);
  }

  /**
   * Create or Find a Distinct Conversation.
   *
   * If the static Conversation.create method gets a request for a Distinct Conversation,
   * see if we have one cached.
   *
   * Will fire the 'conversations:loaded' event if one is provided in this call,
   * and a Conversation is found.
   *
   * @method _createDistinct
   * @static
   * @private
   * @param  {Object} options - See layer.Conversation.create options; participants must be layer.Identity[]
   * @return {layer.Conversation}
   */
  static _createDistinct(options) {
    if (options.participants.indexOf(options.client.user) === -1) {
      options.participants.push(options.client.user);
    }

    const participantsHash = {};
    options.participants.forEach((participant) => {
      participantsHash[participant.id] = participant;
    });

    const conv = options.client.findCachedConversation((aConv) => {
      if (aConv.distinct && aConv.participants.length === options.participants.length) {
        for (let index = 0; index < aConv.participants.length; index++) {
          if (!participantsHash[aConv.participants[index].id]) return false;
        }
        return true;
      }
    });

    if (conv) {
      conv._sendDistinctEvent = new LayerEvent({
        target: conv,
        result: !options.metadata || Util.doesObjectMatch(options.metadata, conv.metadata) ?
          Conversation.FOUND : Conversation.FOUND_WITHOUT_REQUESTED_METADATA,
      }, 'conversations:sent');
      return conv;
    }
  }
}

/**
 * Array of participant ids.
 *
 * Do not directly manipulate;
 * use addParticipants, removeParticipants and replaceParticipants
 * to manipulate the array.
 *
 * @type {layer.Identity[]}
 */
Conversation.prototype.participants = null;


/**
 * Number of unread messages in the conversation.
 *
 * @type {number}
 */
Conversation.prototype.unreadCount = 0;

/**
 * This is a Distinct Conversation.
 *
 * You can have 1 distinct conversation among a set of participants.
 * There are no limits to how many non-distinct Conversations you have have
 * among a set of participants.
 *
 * @type {boolean}
 */
Conversation.prototype.distinct = true;

/**
 * The last layer.Message.ConversationMessage to be sent/received for this Conversation.
 *
 * Value may be a Message that has been locally created but not yet received by server.
 * @type {layer.Message.ConversationMessage}
 */
Conversation.prototype.lastMessage = null;


/**
 * The position of the last known message.
 *
 * Used in the event that lastMessage has been deleted.
 *
 * @private
 * @property {Number}
 */
Conversation.prototype._lastMessagePosition = 0;

/**
 * Indicates if we are currently processing a markAllAsRead operation
 *
 * @private
 * @property {Boolean}
 */
Conversation.prototype._inMarkAllAsRead = false;

Conversation.eventPrefix = 'conversations';

/**
 * The Conversation that was requested has been found, but there was a mismatch in metadata.
 *
 * If the createConversation request contained metadata and it did not match the Distinct Conversation
 * that matched the requested participants, then this value is passed to notify your app that the Conversation
 * was returned but does not exactly match your request.
 *
 * Used in `conversations:sent` events.
 * @type {String}
 * @static
 */
Conversation.FOUND_WITHOUT_REQUESTED_METADATA = 'FoundMismatch';


/**
 * Prefix to use when generating an ID for instances of this class
 * @type {String}
 * @static
 * @private
 */
Conversation.prefixUUID = 'layer:///conversations/';

Conversation._supportedEvents = [
  /**
   * The conversation is now on the server.
   *
   * Called after successfully creating the conversation
   * on the server.  The Result property is one of:
   *
   * * Conversation.CREATED: A new Conversation has been created
   * * Conversation.FOUND: A matching Distinct Conversation has been found
   * * Conversation.FOUND_WITHOUT_REQUESTED_METADATA: A matching Distinct Conversation has been found
   *                       but note that the metadata is NOT what you requested.
   *
   * All of these results will also mean that the updated property values have been
   * copied into your Conversation object.  That means your metadata property may no
   * longer be its initial value; it may be the value found on the server.
   *
   * @event
   * @param {layer.LayerEvent} event
   * @param {string} event.result
   */
  'conversations:sent',

  /**
   * An attempt to send this conversation to the server has failed.
   * @event
   * @param {layer.LayerEvent} event
   * @param {layer.LayerError} event.error
   */
  'conversations:sent-error',

  /**
   * The conversation is now loaded from the server.
   *
   * Note that this is only used in response to the layer.Conversation.load() method.
   * from the server.
   * @event
   * @param {layer.LayerEvent} event
   */
  'conversations:loaded',

  /**
   * An attempt to load this conversation from the server has failed.
   *
   * Note that this is only used in response to the layer.Conversation.load() method.
   * @event
   * @param {layer.LayerEvent} event
   * @param {layer.LayerError} event.error
   */
  'conversations:loaded-error',

  /**
   * The conversation has been deleted from the server.
   *
   * Caused by either a successful call to delete() on this instance
   * or by a remote user.
   * @event
   * @param {layer.LayerEvent} event
   */
  'conversations:delete',

  /**
   * This conversation has changed.
   *
   * @event
   * @param {layer.LayerEvent} event
   * @param {Object[]} event.changes - Array of changes reported by this event
   * @param {Mixed} event.changes.newValue
   * @param {Mixed} event.changes.oldValue
   * @param {string} event.changes.property - Name of the property that changed
   * @param {layer.Conversation} event.target
   */
  'conversations:change'].concat(Syncable._supportedEvents);

Root.initClass.apply(Conversation, [Conversation, 'Conversation']);
Syncable.subclasses.push(Conversation);
module.exports = Conversation;
