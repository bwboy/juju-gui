/*
This file is part of the Juju GUI, which lets users view and manage Juju
environments within a graphical interface (https://launchpad.net/juju-gui).
Copyright (C) 2012-2013 Canonical Ltd.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License version 3, as published by
the Free Software Foundation.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranties of MERCHANTABILITY,
SATISFACTORY QUALITY, or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero
General Public License for more details.

You should have received a copy of the GNU Affero General Public License along
with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

/**
  The ghost inspector is the viewlet manager implementation of the ghost
  configuration view.

  @module views
  @submodule views.ghostInspector
 */

YUI.add('ghost-deployer-extension', function(Y) {

  /**
    JujuGUI app extension to add the ghost deployer method.

    @class GhostDeployer
    @extension App
  */
  function GhostDeployer() {}

  GhostDeployer.prototype = {

    /**
      Show the deploy/configuration panel for a charm.

      @method deployService
      @param {Y.Model} charm model to add to the charms database.
      @param {Object} ghostAttributes The attributes used by the ghost.
      @param {Array} plans The list of plans available for this service.
      @param {String} activePlan The selected plan for this service.
    */
    deployService: function(charm, ghostAttributes, plans, activePlan) {
      // This flag is still required because it comes fully populated from the
      // browser but won't be fully populated when coming in on the delta.
      charm.loaded = true;
      charm.set('plans', plans);
      var db = this.db;
      db.charms.add(charm);
      var ghostService = db.services.ghostService(charm);

      this._setupXYAnnotations(ghostAttributes, ghostService);

      var config = {};
      var ghostServiceId = ghostService.get('id');
      Y.Object.each(charm.get('options'), function(v, k) {
        config[k] = v['default'];
      });
      var series = charm.get('series');
      // If series is an array then pick the first one. This will be the
      // case if it is a multi-series charm and we're picking the default
      // and preferred series.
      var activeSeries = Array.isArray(series) ? series[0] : series;
      ghostService.set('config', config);
      ghostService.set('activePlan', activePlan);
      ghostService.set('series', activeSeries);
      var serviceName = ghostService.get('name');
      var charmId = this._addSeriesToCharmId(charm.get('id'), activeSeries);
      var constraints = {};
      // TODO frankban: add support for fetching delegatable macaroons that can
      // be used to add private charms.
      this.env.addCharm(
        charmId, null, this._addCharmCallbackHandler.bind(this, charm),
        // Options used by ECS, ignored by environment.
        {applicationId: ghostServiceId});
      this.env.deploy(
          charmId,
          activeSeries,
          serviceName,
          config,
          undefined, // Config file content.
          0, // Number of units.
          constraints,
          null, // toMachine.
          this._deployCallbackHandler.bind(this, ghostService),
          // Options used by ECS, ignored by environment.
          {modelId: ghostServiceId});

      // Add an unplaced unit to this service if it is not a subordinate
      // (subordinate units reside alongside non-subordinate units).
      if (!charm.get('is_subordinate')) {
        // The service is not yet deployed (we just added it to ECS), so we
        // can safely assume the first unit to be unit 0. Each subsequent
        // unit added to the ghost service would have number
        // `ghostService.get('units').size()`.
        var unitId = ghostServiceId + '/0';
        var ghostUnit = db.addUnits({
          id: unitId,
          displayName: serviceName + '/0',
          charmUrl: charmId,
          subordinate: charm.get('is_subordinate')
        });
        // Add an ECS add_unit record. Attach a callback that, when called,
        // removes the ghost unit from the database. The real unit should then
        // be created reacting to the mega-watcher changes.
        this.env.add_unit(
            ghostServiceId, // The service to which the unit is added.
            1, // Add a single unit.
            null, // For now the unit is unplaced.
            Y.bind(this._addUnitCallback, this, ghostUnit), // The callback.
            // Options used by ECS, ignored by environment.
            {modelId: unitId}
        );
      }
      this.fire('changeState', {
        sectionA: {
          component: 'inspector',
          metadata: {
            id: ghostService.get('id'),
            localType: null
          }
        },
        sectionC: {
          component: null,
          metadata: null
        }});
    },

    /**
      Adds the series prefix correctly into the charmId if necessary.

      If we're using Juju 1 then we need to deploy a charm Id which has
      the series defined in the URL. This is not required for Juju 2 as it
      supports multi-series charms.

      @method _addSeriesToCharmId
      @param {String} charmId The charm id.
      @param {String} series The series of the service.
    */
    _addSeriesToCharmId: function(charmId, series) {
      let charmIdParts = charmId.replace('cs:', '').split('/');
      if (
        // If we're in Juju 2 then just return the charmId as it can
        // support both single and multi-series charms.
        !this.isLegacyJuju() ||
        // If this is a single series charm already then it'll already
        // have the series in the id.
        charmIdParts.indexOf(series) > -1) {
        return charmId;
      }
      // If none of the above are correct then we need to add the series
      // to the charm id. It is not possible to get here if you have a three
      // part charm Id ie) cs:~user/series/charm-0 so we only need to handle
      // the remaining cases of cs:~user/charm-0 and cs:charm-0
      charmIdParts.length === 2 ?
        charmIdParts.splice(1, 0, series) :
        charmIdParts.unshift(series);
      return `cs:${charmIdParts.join('/')}`;
    },

    /**
      Sets up the gui-x, gui-y annotations on the passed in ghost service.

      @method _setupXYAnnotations
      @param {Object} ghostAttributes The attrs to set on the ghost service.
      @param {Object} ghostService The ghost service model.
    */
    _setupXYAnnotations: function(ghostAttributes, ghostService) {
      if (ghostAttributes !== undefined) {
        if (ghostAttributes.coordinates !== undefined) {
          var annotations = ghostService.get('annotations');
          annotations['gui-x'] = ghostAttributes.coordinates[0];
          annotations['gui-y'] = ghostAttributes.coordinates[1];
        }
        ghostService.set('icon', ghostAttributes.icon);
      }
    },

    /**
      The callback handler for the env.addCharm call.

      @method _addCharmCallbackHandler
      @param {Object} charm The added charm model.
      @param {Object} response The response from Juju.
    */
    _addCharmCallbackHandler: function(charm, response) {
      var db = this.db;
      var charmId = charm.get('id');
      if (response.err) {
        db.notifications.add({
          title: `Error adding ${charmId}`,
          message: 'Could not add requested charm. Server responded with: ' +
            response.err,
          level: 'error'
        });
        return;
      }

      db.notifications.add({
        title: `Added ${charmId} successfully`,
        message: `Successfully added ${charmId}`,
        level: 'info'
      });
    },

    /**
      The callback handler from the env.deploy() of the charm.

      @method _deployCallbackHandler
      @param {Object} ghostService The model of the ghost service.
      @param {Y.EventFacade} evt The event facade from the deploy event.
    */
    _deployCallbackHandler: function(ghostService, evt) {
      var db = this.db;
      var serviceName = ghostService.get('name');

      if (evt.err) {
        db.notifications.add({
          title: 'Error deploying ' + serviceName,
          message: 'Could not deploy the requested application. Server ' +
              'responded with: ' + evt.err.message,
          level: 'error'
        });
        return;
      }

      db.notifications.add({
        title: 'Deployed ' + serviceName,
        message: 'Successfully deployed the requested application.',
        level: 'info'
      });

      // Transition the ghost viewModel to the new service. It's alive!
      var ghostId = ghostService.get('id');

      ghostService.setAttrs({
        id: serviceName,
        displayName: undefined,
        pending: false,
        loading: false,
        config: ghostService.get('config'),
        constraints: {}
      });

      var topo = this.views.environment.instance.topo;
      // Without this following code on a real environment the service icons
      // would disappear and then re-appear when deploying services.
      var boxModel = topo.service_boxes[ghostId];
      boxModel.id = serviceName;
      boxModel.pending = false;
      delete topo.service_boxes[ghostId];
      topo.service_boxes[serviceName] = boxModel;

      topo.annotateBoxPosition(boxModel);
    },

    /**
      The callback handler from the env.add_unit() call.

      @method _addUnitCallback
      @param {Object} ghostUnit The ghost unit model instance.
      @param {Y.EventFacade} evt The event facade from the add_unit call.
    */
    _addUnitCallback: function(ghostUnit, evt) {
      var db = this.db;
      if (evt.err) {
        // Add a notification and exit if the API call failed.
        db.notifications.add({
          title: 'Error adding unit ' + ghostUnit.displayName,
          message: 'Could not add the requested unit. Server ' +
              'responded with: ' + evt.err,
          level: 'error'
        });
        return;
      }
      // Notify the unit has been successfully created.
      db.notifications.add({
        title: 'Added unit ' + ghostUnit.displayName,
        message: 'Successfully created the requested unit.',
        level: 'info'
      });
      // Remove the ghost unit: the real unit will be re-added by the
      // mega-watcher handlers.
      ghostUnit.service = evt.applicationName;
      db.removeUnits(ghostUnit);
    }
  };

  Y.namespace('juju').GhostDeployer = GhostDeployer;

}, '0.1.0', {
  requires: []
});
