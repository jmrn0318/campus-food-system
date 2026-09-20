(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.getRegistrations().then(function (registrations) {
        return Promise.all(registrations.map(function (registration) { return registration.update(); }));
      }).then(function () {
        return navigator.serviceWorker.register('/service-worker.js?v=2');
      }).catch(function () {
        /* The app remains usable online if installation is unavailable. */
      });
    });
  }
})();
