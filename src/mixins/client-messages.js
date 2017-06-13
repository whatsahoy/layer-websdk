/**
 * Adds Message handling to the layer.Client.
 *
 * @class layer.mixins.ClientMessages
 */

const Syncable = require('../models/syncable');
const Message = require('../models/message');
const ErrorDictionary = require('../layer-error').dictionary;

module.exports = {
  events: [
    /**
     * A new message has been received for which a notification may be suitable.
     *
     * This event is triggered for messages that are:
     *
     * 1. Added via websocket rather than other IO
     * 2. Not yet been marked as read
     * 3. Not sent by this user
     *
            client.on('messages:notify', function(evt) {
                myNotify(evt.message);
            })
    *
    * @event
    * @param {layer.LayerEvent} evt
    * @param {layer.Message} evt.Message
    */
    'messages:notify',

    /**
     * Messages have been added to a conversation.
     *
     * May also fire when new Announcements are received.
     *
     * This event is triggered on
     *
     * * creating/sending a new message
     * * Receiving a new layer.Message or layer.Announcement via websocket
     * * Querying/downloading a set of Messages
     *
            client.on('messages:add', function(evt) {
                evt.messages.forEach(function(message) {
                    myView.addMessage(message);
                });
            });
    *
    * NOTE: Such rendering would typically be done using events on layer.Query.
    *
    * @event
    * @param {layer.LayerEvent} evt
    * @param {layer.Message[]} evt.messages
    */
    'messages:add',

    /**
     * A message has been removed from a conversation.
     *
     * A removed Message is not necessarily deleted,
     * just no longer being held in memory.
     *
     * Note that typically you will want the messages:delete event
     * rather than messages:remove.
     *
     *      client.on('messages:remove', function(evt) {
     *          evt.messages.forEach(function(message) {
     *              myView.removeMessage(message);
     *          });
     *      });
     *
     * NOTE: Such rendering would typically be done using events on layer.Query.
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Message} evt.message
     */
    'messages:remove',

    /**
     * A message has been sent.
     *
     *      client.on('messages:sent', function(evt) {
     *          alert(evt.target.getText() + ' has been sent');
     *      });
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Message} evt.target
     */
    'messages:sent',

    /**
     * A message is about to be sent.
     *
     * Useful if you want to
     * add parts to the message before it goes out.
     *
     *      client.on('messages:sending', function(evt) {
     *          evt.target.addPart({
     *              mimeType: 'text/plain',
     *              body: 'this is just a test'
     *          });
     *      });
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Message} evt.target
     */
    'messages:sending',

    /**
     * Server failed to receive a Message.
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.LayerError} evt.error
     */
    'messages:sent-error',

    /**
     * A message has had a change in its properties.
     *
     * This change may have been delivered from a remote user
     * or as a result of a local operation.
     *
     *      client.on('messages:change', function(evt) {
     *          var recpientStatusChanges = evt.getChangesFor('recipientStatus');
     *          if (recpientStatusChanges.length) {
     *              myView.renderStatus(evt.target);
     *          }
     *      });
     *
     * NOTE: Such rendering would typically be done using events on layer.Query.
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Message} evt.target
     * @param {Object[]} evt.changes
     * @param {Mixed} evt.changes.newValue
     * @param {Mixed} evt.changes.oldValue
     * @param {string} evt.changes.property - Name of the property that has changed
     */
    'messages:change',


    /**
     * A call to layer.Message.load has completed successfully
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Message} evt.target
     */
    'messages:loaded',

    /**
     * A Message has been deleted from the server.
     *
     * Caused by either a successful call to layer.Message.delete() on the Message
     * or by a remote user.
     *
     *      client.on('messages:delete', function(evt) {
     *          myView.removeMessage(evt.target);
     *      });
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Message} evt.target
     */
    'messages:delete',
  ],
  lifecycle: {
    constructor(options) {
      this._models.messages = {};
    },
    cleanup() {
      Object.keys(this._models.messages).forEach((id) => {
        const message = this._models.messages[id];
        if (message && !message.isDestroyed) {
          message.destroy();
        }
      });
      this._models.messages = null;
    },
    reset() {
      this._models.messages = {};
    },
  },
  methods: {
    /**
     * Retrieve the message or announcement by ID.
     *
     * Useful for finding a message when you have only the ID.
     *
     * If the message is not found, it will return null.
     *
     * If you want it to load it from cache and then from server if not in cache, use the `canLoad` parameter.
     * If loading from the server, the method will return
     * a layer.Message instance that has no data; the messages:loaded/messages:loaded-error events
     * will let you know when the message has finished/failed loading from the server.
     *
     *      var m = client.getMessage('layer:///messages/123', true)
     *      .on('messages:loaded', function() {
     *          // Render the Message with all of its details loaded
     *          myrerender(m);
     *      });
     *      // Render a placeholder for m until the details of m have loaded
     *      myrender(m);
     *
     *
     * @method getMessage
     * @param  {string} id              - layer:///messages/uuid
     * @param  {boolean} [canLoad=false] - Pass true to allow loading a message from the server if not found
     * @return {layer.Message}
     */
    getMessage(id, canLoad) {
      let result = null;

      if (typeof id !== 'string') throw new Error(ErrorDictionary.idParamRequired);

      // NOTE: This could be an announcement
      if (id.indexOf('layer:///') !== 0) {
        id = Message.prefixUUID + id;
      }

      if (this._models.messages[id]) {
        result = this._models.messages[id];
      } else if (canLoad) {
        result = Syncable.load(id, this);
      }
      if (canLoad) result._loadType = 'fetched';

      return result;
    },

    /**
     * Get a MessagePart by ID
     *
     * ```
     * var part = client.getMessagePart('layer:///messages/6f08acfa-3268-4ae5-83d9-6ca00000000/parts/0');
     * ```
     *
     * @method getMessagePart
     * @param {String} id - ID of the Message Part; layer:///messages/uuid/parts/5
     */
    getMessagePart(id) {
      if (typeof id !== 'string') throw new Error(ErrorDictionary.idParamRequired);

      const messageId = id.replace(/\/parts.*$/, '');
      const message = this.getMessage(messageId);
      if (message) return message.getPartById(id);
      return null;
    },

    /**
     * Registers a message in _models.messages and triggers events.
     *
     * May also update Conversation.lastMessage.
     *
     * @method _addMessage
     * @protected
     * @param  {layer.Message} message
     */
    _addMessage(message) {
      if (!this._models.messages[message.id]) {
        this._models.messages[message.id] = message;
        this._triggerAsync('messages:add', { messages: [message] });
        if (message._notify) {
          this._triggerAsync('messages:notify', { message });
          message._notify = false;
        }

        const conversation = message.getConversation(false);
        if (conversation && (!conversation.lastMessage || conversation.lastMessage.position < message.position)) {
          const lastMessageWas = conversation.lastMessage;
          conversation.lastMessage = message;
          if (lastMessageWas) this._scheduleCheckAndPurgeCache(lastMessageWas);
        } else {
          this._scheduleCheckAndPurgeCache(message);
        }
      }
    },

    /**
     * Removes message from _models.messages.
     *
     * Accepts IDs or Message instances
     *
     * TODO: Remove support for remove by ID
     *
     * @method _removeMessage
     * @private
     * @param  {layer.Message|string} message or Message ID
     */
    _removeMessage(message) {
      const id = (typeof message === 'string') ? message : message.id;
      message = this._models.messages[id];
      if (message) {
        delete this._models.messages[id];
        if (!this._inCleanup) {
          this._triggerAsync('messages:remove', { messages: [message] });
          const conv = message.getConversation(false);

          // Websocket will eventually deliver an update to the latest lastMessage;
          // until then, use the old lastMessage's position as a placeholder
          if (!this._inCheckAndPurgeCache && conv && conv.lastMessage === message) {
            conv.lastMessage = null;
            conv._lastMessagePosition = message.position;
          }
        }
      }
    },

    /**
     * Handles delete from position event from Websocket.
     *
     * A WebSocket may deliver a `delete` Conversation event with a
     * from_position field indicating that all Messages at the specified position
     * and earlier should be deleted.
     *
     * @method _purgeMessagesByPosition
     * @private
     * @param {string} conversationId
     * @param {number} fromPosition
     */
    _purgeMessagesByPosition(conversationId, fromPosition) {
      Object.keys(this._models.messages).forEach((id) => {
        const message = this._models.messages[id];
        if (message.conversationId === conversationId && message.position <= fromPosition) {
          message.destroy();
        }
      });
    },

  },
};
