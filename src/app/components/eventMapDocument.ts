import type { EventLocation } from '../../common/eventInfo'
import sdk from '../assets/leafletRuntime.json'

/** Trusted pinned SDK text; untrusted settings are encoded as JSON, never markup. */
export function eventMapDocument(location: EventLocation): string {
  if (
    location.latitude == null ||
    location.longitude == null ||
    !Number.isFinite(location.latitude) ||
    !Number.isFinite(location.longitude) ||
    Math.abs(location.latitude) > 90 ||
    Math.abs(location.longitude) > 180
  )
    throw new Error('The address could not be located.')
  const config = JSON.stringify(location).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="origin"><style>${sdk.css}
    html,body,#map{height:100%;width:100%;margin:0} .event-marker{background:#2376cf;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px #0006;width:18px;height:18px}
    #error{position:absolute;left:12px;top:12px;background:white;padding:8px;z-index:1000;font:14px sans-serif;display:none}
  </style></head><body><div id="map" aria-label="Event location map"></div><div id="error" role="alert">Map tiles could not load. You can still open directions.</div><script>${sdk.js}</script><script>
    const config=${config};
    const map=L.map('map',{scrollWheelZoom:false}).setView([config.latitude,config.longitude],15);
    const tiles=L.tileLayer(config.tileUrl,{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
    tiles.on('tileerror',()=>{document.getElementById('error').style.display='block'});
    tiles.on('tileload',()=>{document.getElementById('error').style.display='none'});
    L.marker([config.latitude,config.longitude],{icon:L.divIcon({className:'event-marker',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(map);
    window.eventMap=map;
    map.on('moveend',()=>{window.eventMapCenter={latitude:map.getCenter().lat,longitude:map.getCenter().lng}});
  </script></body></html>`
}
