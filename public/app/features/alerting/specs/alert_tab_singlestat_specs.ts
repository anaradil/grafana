import { describe, it, expect } from 'test/lib/common';

import { AlertTabSingleStatCtrl } from '../alert_tab_singlestat_ctrl';

describe('AlertTabSingleStatCtrl', () => {
  var $scope = {
    ctrl: {},
  };

  describe('with null parameters', () => {
    it('can be created', () => {
      var alertTabSingleStat = new AlertTabSingleStatCtrl($scope, null, null, null, null, null);

      expect(alertTabSingleStat).to.not.be(null);
    });
  });
});
