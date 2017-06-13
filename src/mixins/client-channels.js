/**
 * Adds Channel handling to the layer.Client.
 *
 * @class layer.mixins.ClientChannels
 */

const Channel = require('../models/channel');
const ErrorDictionary = require('../layer-error').dictionary;

module.exports = {
  events: [
    /**
     * One or more layer.Channel objects have been added to the client.
     *
     * They may have been added via the websocket, or via the user creating
     * a new Channel locally.
     *
     *      client.on('channels:add', function(evt) {
     *          evt.channels.forEach(function(channel) {
     *              myView.addChannel(channel);
     *          });
     *      });
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Channel[]} evt.channels - Array of channels added
     */
    'channels:add',

    /**
     * One or more layer.Channel objects have been removed.
     *
     * A removed Channel is not necessarily deleted, its just
     * no longer being held in local memory.
     *
     * Note that typically you will want the channels:delete event
     * rather than channels:remove.
     *
     *      client.on('channels:remove', function(evt) {
     *          evt.channels.forEach(function(channel) {
     *              myView.removeChannel(channel);
     *          });
     *      });
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Channel[]} evt.channels - Array of channels removed
     */
    'channels:remove',

    /**
     * A channel had a change in its properties.
     *
     * This change may have been delivered from a remote user
     * or as a result of a local operation.
     *
     *      client.on('channels:change', function(evt) {
     *          var metadataChanges = evt.getChangesFor('metadata');
     *          var participantChanges = evt.getChangesFor('members');
     *          if (metadataChanges.length) {
     *              myView.renderTitle(evt.target.metadata.title);
     *          }
     *          if (participantChanges.length) {
     *              myView.rendermembers(evt.target.members);
     *          }
     *      });
     *
     * NOTE: Typically such rendering is done using Events on layer.Query.
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Channel} evt.target
     * @param {Object[]} evt.changes
     * @param {Mixed} evt.changes.newValue
     * @param {Mixed} evt.changes.oldValue
     * @param {string} evt.changes.property - Name of the property that has changed
     */
    'channels:change',

    /**
     * A call to layer.Channel.load has completed successfully
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Channel} evt.target
     */
    'channels:loaded',

    /**
     * A Channel has been deleted from the server.
     *
     * Caused by either a successful call to layer.Channel.delete() on the Channel
     * or by a remote user.
     *
     *      client.on('channels:delete', function(evt) {
     *          myView.removeChannel(evt.target);
     *      });
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Channel} evt.target
     */
    'channels:delete',


    /**
     * The channel is now on the server.
     *
     * Called after creating the channel
     * on the server.  The Result property is one of:
     *
     * * layer.Channel.CREATED: A new Channel has been created
     * * layer.Channel.FOUND: A matching Channel has been found
     *
     * All of these results will also mean that the updated property values have been
     * copied into your Channel object.  That means your metadata property may no
     * longer be its initial value; it will be the value found on the server.
     *
     *      client.on('channels:sent', function(evt) {
     *          switch(evt.result) {
     *              case Channel.CREATED:
     *                  alert(evt.target.id + ' Created!');
     *                  break;
     *              case Channel.FOUND:
     *                  alert(evt.target.id + ' Found!');
     *                  break;
     *          }
     *      });
     *
     * @event
     * @param {layer.LayerEvent} event
     * @param {string} event.result
     * @param {layer.Channel} target
     */
    'channels:sent',

    /**
     * A channel failed to load or create on the server.
     *
     *      client.on('channels:sent-error', function(evt) {
     *          alert(evt.data.message);
     *      });
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.LayerError} evt.data
     * @param {layer.Channel} target
     */
    'channels:sent-error',
  ],
  lifecycle: {
    constructor(options) {
      this._models.channels = {};
    },
    cleanup() {
      Object.keys(this._models.channels).forEach((id) => {
        const channel = this._models.channels[id];
        if (channel && !channel.isDestroyed) {
          channel.destroy();
        }
      });
      this._models.channels = null;
    },

    reset() {
      this._models.channels = {};
    },

  },
  methods: {
    /**
     * Retrieve a channel by Identifier.
     *
     *      var c = client.getChannel('layer:///channels/uuid');
     *
     * If there is not a channel with that id, it will return null.
     *
     * If you want it to load it from cache and then from server if not in cache, use the `canLoad` parameter.
     * If loading from the server, the method will return
     * a layer.Channel instance that has no data; the `channels:loaded` / `channels:loaded-error` events
     * will let you know when the channel has finished/failed loading from the server.
     *
     *      var c = client.getChannel('layer:///channels/123', true)
     *      .on('channels:loaded', function() {
     *          // Render the Channel with all of its details loaded
     *          myrerender(c);
     *      });
     *      // Render a placeholder for c until the details of c have loaded
     *      myrender(c);
     *
     * Note in the above example that the `channels:loaded` event will trigger even if the Channel has previously loaded.
     *
     * @method getChannel
     * @param  {string} id
     * @param  {boolean} [canLoad=false] - Pass true to allow loading a channel from
     *                                    the server if not found
     * @return {layer.Channel}
     */
    getChannel(id, canLoad) {
      let result = null;

      if (typeof id !== 'string') throw new Error(ErrorDictionary.idParamRequired);
      if (!Channel.isValidId(id)) {
        id = Channel.prefixUUID + id;
      }
      if (this._models.channels[id]) {
        result = this._models.channels[id];
      } else if (canLoad) {
        result = Channel.load(id, this);
      }
      if (canLoad) result._loadType = 'fetched';
      return result;
    },

    /**
     * Adds a channel to the client.
     *
     * Typically, you do not need to call this; the following code
     * automatically calls _addChannel for you:
     *
     *      var conv = new layer.Channel({
     *          client: client,
     *          members: ['a', 'b']
     *      });
     *
     *      // OR:
     *      var conv = client.createChannel(['a', 'b']);
     *
     * @method _addChannel
     * @protected
     * @param  {layer.Channel} c
     */
    _addChannel(channel) {
      const id = channel.id;
      if (!this._models.channels[id]) {
        // Register the Channel
        this._models.channels[id] = channel;

        // Make sure the client is set so that the next event bubbles up
        if (channel.clientId !== this.appId) channel.clientId = this.appId;
        this._triggerAsync('channels:add', { channels: [channel] });

        this._scheduleCheckAndPurgeCache(channel);
      }
    },

    /**
     * Removes a channel from the client.
     *
     * Typically, you do not need to call this; the following code
     * automatically calls _removeChannel for you:
     *
     *      channel.destroy();
     *
     * @method _removeChannel
     * @protected
     * @param  {layer.Channel} c
     */
    _removeChannel(channel) {
      // Insure we do not get any events, such as message:remove
      channel.off(null, null, this);

      if (this._models.channels[channel.id]) {
        delete this._models.channels[channel.id];
        this._triggerAsync('channels:remove', { channels: [channel] });
      }

      // Remove any Message associated with this Channel
      Object.keys(this._models.messages).forEach((id) => {
        if (this._models.messages[id].channelId === channel.id) {
          this._models.messages[id].destroy();
        }
      });
    },

    /**
     * If the Channel ID changes, we need to reregister the Channel
     *
     * @method _updateChannelId
     * @protected
     * @param  {layer.Channel} channel - Channel whose ID has changed
     * @param  {string} oldId - Previous ID
     */
    _updateChannelId(channel, oldId) {
      if (this._models.channels[oldId]) {
        this._models.channels[channel.id] = channel;
        delete this._models.channels[oldId];

        // This is a nasty way to work... but need to find and update all
        // channelId properties of all Messages or the Query's won't
        // see these as matching the query.
        Object.keys(this._models.messages)
              .filter(id => this._models.messages[id].conversationId === oldId)
              .forEach(id => (this._models.messages[id].conversationId = channel.id));
      }
    },

    /**
     * Searches locally cached channels for a matching channel.
     *
     * Iterates over channels calling a matching function until
     * the channel is found or all channels tested.
     *
     *      var c = client.findCachedChannel(function(channel) {
     *          if (channel.participants.indexOf('a') != -1) return true;
     *      });
     *
     * @method findCachedChannel
     * @param  {Function} f - Function to call until we find a match
     * @param  {layer.Channel} f.channel - A channel to test
     * @param  {boolean} f.return - Return true if the channel is a match
     * @param  {Object} [context] - Optional context for the *this* object
     * @return {layer.Channel}
     *
     * @deprecated
     * This should be replaced by iterating over your layer.Query data.
     */
    findCachedChannel(func, context) {
      const test = context ? func.bind(context) : func;
      const list = Object.keys(this._models.channels);
      const len = list.length;
      for (let index = 0; index < len; index++) {
        const key = list[index];
        const channel = this._models.channels[key];
        if (test(channel, index)) return channel;
      }
      return null;
    },

    /**
     * This method is recommended way to create a Channel.
     *
     * ```
     *         client.createChannel({
     *             members: ['layer:///identities/a', 'layer:///identities/b'],
     *             name: 'a-channel'
     *         });
     *         client.createChannel({
     *             members: [userIdentityObjectA, userIdentityObjectB],
     *             name: 'another-channel'
     *         });
     *
     *         client.createChannel({
     *             members: ['layer:///identities/a', 'layer:///identities/b'],
     *             name: 'a-channel-with-metadata',
     *             metadata: {
     *                 topicDetails: 'I am a detail'
     *             }
     *         });
     * ```
     *
     * If you try to create a Channel with a name that already exists,
     * you will get back an existing Channel, and any requested metadata and members
     * will NOT be set; you will get whatever metadata the matching Conversation
     * already had, and no members will be added/removed.
     *
     * Whether the Channel already exists or not, a 'channels:sent' event
     * will be triggered asynchronously and the Channel object will be ready
     * at that time.  Further, the event will provide details on the result:
     *
     * ```
     *       var channel = client.createChannel({
     *          members: ['a', 'b'],
     *          name: 'yet-another-channel-with-metadata',
     *          metadata: {
     *                 topicDetails: 'I am a detail'
     *          }
     *       });
     *       channel.on('channels:sent', function(evt) {
     *           switch(evt.result) {
     *               case Channel.CREATED:
     *                   alert(channel.id + ' was created');
     *                   break;
     *               case Channel.FOUND:
     *                   alert(channel.id + ' was found');
     *                   break;
     *               case Channel.FOUND_WITHOUT_REQUESTED_METADATA:
     *                   alert(channel.id + ' was found but it already has a topicDetails so your requested detail was not set');
     *                   break;
     *            }
     *       });
     * ```
     *
     * Warning: This method will throw an error if called when you are not (or are no longer) an authenticated user.
     * That means if authentication has expired, and you have not yet reauthenticated the user, this will throw an error.
     *
     *
     * @method createChannel
     * @param  {Object} options
     * @param {string[]/layer.Identity[]} options.members - Array of UserIDs or UserIdentities
     * @param {String} options.name - The unique name for this Channel
     * @param {Object} [options.metadata={}] Metadata for your Channel
     * @return {layer.Channel}
     */
    createChannel(options) {
      // If we aren't authenticated, then we don't yet have a UserID, and won't create the correct Channel
      if (!this.isAuthenticated) throw new Error(ErrorDictionary.clientMustBeReady);
      if (!('private' in options)) options.private = false;
      options.client = this;
      options._loadType = 'websocket'; // treat this the same as a websocket loaded object
      return Channel.create(options);
    },
  },
};
