/* global document, window, URLSearchParams */
// A stand-in for Google's Maps JavaScript API, for the end-to-end tests. The
// tests intercept `https://maps.googleapis.com/maps/api/js?…` and answer it
// with this file, so the app's own map document runs against it unchanged.
//
// - `google.maps.importLibrary('maps')` gives a `Map` that paints its node
//   and fires `tilesloaded` and `idle`.
// - `importLibrary('marker')` gives an `AdvancedMarkerElement` that draws a
//   pin carrying `data-lat`, `data-lng` and `data-draggable`.
// - `window.__dragPin(lat, lng)` moves the last marker there and fires its
//   `dragend`, as letting go of a dragged pin does. It refuses a pin that is
//   not draggable.
// - Loaded with `authFailure=1` in its address, it calls
//   `window.gm_authFailure()`, as Google does for a refused key. Otherwise it
//   calls the address's `callback`.
//
// It runs in the page as it is, untranspiled.
;(function () {
  'use strict'
  const script = document.currentScript
  const source = script == null ? '' : script.src
  const query = new URLSearchParams(source.split('?')[1] || '')

  function on(listeners, name, listener) {
    if (listeners[name] == null) listeners[name] = []
    listeners[name].push(listener)
    return {
      remove: function () {
        listeners[name] = listeners[name].filter(function (item) {
          return item !== listener
        })
      }
    }
  }
  function fire(listeners, name) {
    ;(listeners[name] || []).forEach(function (listener) {
      listener()
    })
  }

  function Map(node, options) {
    this.node = node
    this.options = options
    this.listeners = {}
    node.dataset.googleMapsStub = 'true'
    node.style.position = 'relative'
    node.style.overflow = 'hidden'
    node.style.background =
      'linear-gradient(115deg, transparent 46%, #d9d2b8 46%, #d9d2b8 50%, transparent 50%),' +
      'linear-gradient(15deg, transparent 63%, #c9c2a8 63%, #c9c2a8 65%, transparent 65%),' +
      'radial-gradient(circle at 30% 40%, #5f7d4c 0, #4b6a3c 35%, #3f5a33 70%)'
    const label = document.createElement('div')
    label.textContent = 'Google Maps (test stub)'
    label.style.cssText =
      'position:absolute;left:6px;bottom:6px;padding:2px 6px;border-radius:4px;background:#fffd;color:#3c4043;font:12px/1.3 sans-serif'
    node.appendChild(label)
    const map = this
    setTimeout(function () {
      fire(map.listeners, 'tilesloaded')
      fire(map.listeners, 'idle')
    }, 0)
  }
  Map.prototype.addListener = function (name, listener) {
    return on(this.listeners, name, listener)
  }
  Map.prototype.getCenter = function () {
    const center = this.options.center
    return {
      lat: function () {
        return center.lat
      },
      lng: function () {
        return center.lng
      }
    }
  }

  function AdvancedMarkerElement(options) {
    this.map = options.map
    this.position = { lat: options.position.lat, lng: options.position.lng }
    this.title = options.title || ''
    this.gmpDraggable = options.gmpDraggable === true
    this.listeners = {}
    const pin = document.createElement('div')
    pin.className = 'google-maps-stub-pin'
    pin.setAttribute('role', 'img')
    pin.setAttribute('aria-label', this.title)
    pin.style.cssText =
      'position:absolute;left:50%;top:50%;width:26px;height:26px;margin:-26px 0 0 -13px;' +
      'background:#ea4335;border:2px solid #b31412;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 4px #0006'
    this.element = pin
    this.show()
    this.map.node.appendChild(pin)
    window.__stubMarker = this
  }
  AdvancedMarkerElement.prototype.show = function () {
    this.element.dataset.lat = String(this.position.lat)
    this.element.dataset.lng = String(this.position.lng)
    this.element.dataset.draggable = String(this.gmpDraggable)
  }
  AdvancedMarkerElement.prototype.addListener = function (name, listener) {
    return on(this.listeners, name, listener)
  }

  window.__dragPin = function (lat, lng) {
    const marker = window.__stubMarker
    if (marker == null) throw new Error('The map has no pin yet')
    if (!marker.gmpDraggable) throw new Error('The pin is not draggable')
    marker.position = { lat, lng }
    marker.show()
    fire(marker.listeners, 'dragend')
  }

  window.google = {
    maps: {
      importLibrary: function (name) {
        if (name === 'maps') return Promise.resolve({ Map })
        if (name === 'marker')
          return Promise.resolve({
            AdvancedMarkerElement
          })
        return Promise.reject(new Error('No stubbed library ' + name))
      }
    }
  }

  setTimeout(function () {
    if (query.get('authFailure') === '1') {
      if (typeof window.gm_authFailure === 'function') window.gm_authFailure()
      return
    }
    const callback = query.get('callback')
    if (callback != null && typeof window[callback] === 'function')
      window[callback]()
  }, 0)
})()
