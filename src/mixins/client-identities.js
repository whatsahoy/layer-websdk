/**
 * Adds Identity handling to the layer.Client.
 *
 * @class layer.mixins.ClientIdentities
 */

const Identity = require('../models/identity');
const ErrorDictionary = require('../layer-error').dictionary;
const Util = require('../client-utils');
const { WebsocketSyncEvent } = require('../sync-event');

module.exports = {
  events: [
    /**
     * A call to layer.Identity.load has completed successfully
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Identity} evt.target
     */
    'identities:loaded',

    /**
     * A call to layer.Identity.load has failed
     *
     * @event
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.LayerError} evt.error
     */
    'identities:loaded-error',

    /**
     * An Identity has had a change in its properties.
     *
     * Changes occur when new data arrives from the server.
     *
     *      client.on('identities:change', function(evt) {
     *          var displayNameChanges = evt.getChangesFor('displayName');
     *          if (displayNameChanges.length) {
     *              myView.renderStatus(evt.target);
     *          }
     *      });
     *
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Identity} evt.target
     * @param {Object[]} evt.changes
     * @param {Mixed} evt.changes.newValue
     * @param {Mixed} evt.changes.oldValue
     * @param {string} evt.changes.property - Name of the property that has changed
     */
    'identities:change',

    /**
     * Identities have been added to the Client.
     *
     * This event is triggered whenever a new layer.Identity (Full identity or not)
     * has been received by the Client.
     *
            client.on('identities:add', function(evt) {
                evt.identities.forEach(function(identity) {
                    myView.addIdentity(identity);
                });
            });
    *
    * @event
    * @param {layer.LayerEvent} evt
    * @param {layer.Identity[]} evt.identities
    */
    'identities:add',

    /**
     * Identities have been removed from the Client.
     *
     * This does not typically occur.
     *
            client.on('identities:remove', function(evt) {
                evt.identities.forEach(function(identity) {
                    myView.addIdentity(identity);
                });
            });
    *
    * @event
    * @param {layer.LayerEvent} evt
    * @param {layer.Identity[]} evt.identities
    */
    'identities:remove',

    /**
     * An Identity has been unfollowed or deleted.
     *
     * We do not delete such Identities entirely from the Client as
     * there are still Messages from these Identities to be rendered,
     * but we do downgrade them from Full Identity to Basic Identity.
     * @event
     * @param {layer.LayerEvent} evt
     * @param {layer.Identity} evt.target
     */
    'identities:unfollow',
  ],
  lifecycle: {
    constructor(options) {
      this._models.identities = {};
      this._loadPresenceIds = [];
    },
    cleanup() {
      Object.keys(this._models.identities).forEach((id) => {
        const identity = this._models.identities[id];
        if (identity && !identity.isDestroyed) {
          identity.destroy();
        }
      });
      this._models.identities = null;
    },

    reset() {
      this._models.identities = {};
    },
  },
  methods: {
    /**
     * Retrieve a identity by Identifier.
     *
     *      var identity = client.getIdentity('layer:///identities/user_id');
     *
     * If there is not an Identity with that id, it will return null.
     *
     * If you want it to load it from cache and then from server if not in cache, use the `canLoad` parameter.
     * This is only supported for User Identities, not Service Identities.
     *
     * If loading from the server, the method will return
     * a layer.Identity instance that has no data; the identities:loaded/identities:loaded-error events
     * will let you know when the identity has finished/failed loading from the server.
     *
     *      var user = client.getIdentity('layer:///identities/123', true)
     *      .on('identities:loaded', function() {
     *          // Render the user list with all of its details loaded
     *          myrerender(user);
     *      });
     *      // Render a placeholder for user until the details of user have loaded
     *      myrender(user);
     *
     * @method getIdentity
     * @param  {string} id - Accepts full Layer ID (layer:///identities/frodo-the-dodo) or just the UserID (frodo-the-dodo).
     * @param  {boolean} [canLoad=false] - Pass true to allow loading an identity from
     *                                    the server if not found
     * @return {layer.Identity}
     */
    getIdentity(id, canLoad) {
      let result = null;
      if (typeof id !== 'string') throw new Error(ErrorDictionary.idParamRequired);
      if (!Identity.isValidId(id)) {
        id = Identity.prefixUUID + encodeURIComponent(id);
      }

      if (this._models.identities[id]) {
        result = this._models.identities[id];
      } else if (canLoad) {
        result = Identity.load(id, this);
      }
      if (canLoad) result._loadType = 'fetched';
      return result;
    },

    /**
     * Adds an identity to the client.
     *
     * Typically, you do not need to call this; the Identity constructor will call this.
     *
     * @method _addIdentity
     * @protected
     * @param  {layer.Identity} identity
     *
     * TODO: It should be possible to add an Identity whose userId is populated, but
     * other values are not yet loaded from the server.  Should add to _models.identities now
     * but trigger `identities:add` only when its got enough data to be renderable.
     */
    _addIdentity(identity) {
      const id = identity.id;
      if (id && !this._models.identities[id]) {
        // Register the Identity
        this._models.identities[id] = identity;
        this._triggerAsync('identities:add', { identities: [identity] });

        /* Bot messages from SAPI 1.0 generate an Identity that has no `id` */
        if (identity.id && identity._presence.status === null && !identity.sessionOwner) {
          this._loadPresenceIds.push(id);
          if (this._loadPresenceIds.length === 1) {
            setTimeout(() => {
              if (!this.isDestroyed) this._loadPresence();
            }, 150);
          }
        }
      }
    },

    /**
     * Removes an identity from the client.
     *
     * Typically, you do not need to call this; the following code
     * automatically calls _removeIdentity for you:
     *
     *      identity.destroy();
     *
     * @method _removeIdentity
     * @protected
     * @param  {layer.Identity} identity
     */
    _removeIdentity(identity) {
      // Insure we do not get any events, such as message:remove
      identity.off(null, null, this);

      const id = identity.id;
      if (this._models.identities[id]) {
        delete this._models.identities[id];
        this._triggerAsync('identities:remove', { identities: [identity] });
      }
    },

    /**
     * Follow this user and get Full Identity, and websocket changes on Identity.
     *
     * @method followIdentity
     * @param  {string} id - Accepts full Layer ID (layer:///identities/frodo-the-dodo) or just the UserID (frodo-the-dodo).
     * @returns {layer.Identity}
     */
    followIdentity(id) {
      if (!Identity.isValidId(id)) {
        id = Identity.prefixUUID + encodeURIComponent(id);
      }
      let identity = this.getIdentity(id);
      if (!identity) {
        identity = new Identity({
          id,
          clientId: this.appId,
          userId: id.substring(20),
        });
      }
      identity.follow();
      return identity;
    },

    /**
     * Unfollow this user and get only Basic Identity, and no websocket changes on Identity.
     *
     * @method unfollowIdentity
     * @param  {string} id - Accepts full Layer ID (layer:///identities/frodo-the-dodo) or just the UserID (frodo-the-dodo).
     * @returns {layer.Identity}
     */
    unfollowIdentity(id) {
      if (!Identity.isValidId(id)) {
        id = Identity.prefixUUID + encodeURIComponent(id);
      }
      let identity = this.getIdentity(id);
      if (!identity) {
        identity = new Identity({
          id,
          clientId: this.appId,
          userId: id.substring(20),
        });
      }
      identity.unfollow();
      return identity;
    },

    /**
     * Load presence data for a batch of Idenity IDs.
     *
     * TODO: This uses the syncManager to request presence because the syncManager
     *   knows how to wait until the websocket is connected, and retry until the request completes.
     *   BUT: this is not ideal, because it must wait if there are any other requests already queued;
     *   this is a READ not a WRITE and should not have to wait.
     *
     * @method _loadPresence
     * @private
     */
    _loadPresence() {
      const ids = this._loadPresenceIds;
      this._loadPresenceIds = [];
      this.syncManager.request(new WebsocketSyncEvent({
        data: {
          method: 'Presence.sync',
          data: { ids },
        },
        returnChangesArray: true,
        operation: 'READ',
        target: null,
        depends: [],
      }));
    },
  },
};
