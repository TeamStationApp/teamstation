import type { EventLocation } from '../../common/eventInfo'

/** The browser-restricted display key is fetched from the selected event's server. */
export function googleMapDocument(location: EventLocation): string {
  if (location.googleMapsApiKey == null || location.googleMapsApiKey === '')
    throw new Error('Google Maps is not configured.')
  if (
    location.latitude == null ||
    location.longitude == null ||
    !Number.isFinite(location.latitude) ||
    !Number.isFinite(location.longitude) ||
    Math.abs(location.latitude) > 90 ||
    Math.abs(location.longitude) > 180
  )
    throw new Error('The address could not be located.')
  const config = JSON.stringify({
    latitude: location.latitude,
    longitude: location.longitude,
    key: location.googleMapsApiKey
  }).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="origin"><style>
    html,body,#map{height:100%;width:100%;margin:0} #error{position:absolute;left:12px;top:12px;background:white;padding:8px;z-index:10;font:14px sans-serif;display:none}
  </style></head><body><div id="map" aria-label="Event location map"></div><div id="error" role="alert">Google Maps could not load. You can still open directions. <button id="retry-map" type="button">Retry map</button></div><script>
    const config=${config};
    const fail=()=>{document.getElementById('error').style.display='block'};
    window.gm_authFailure=fail;
    const timeout=setTimeout(fail,15000);
    window.initEventMap=async()=>{try{
      const {Map}=await google.maps.importLibrary('maps');
      const {AdvancedMarkerElement}=await google.maps.importLibrary('marker');
      const center={lat:config.latitude,lng:config.longitude};
      const map=new Map(document.getElementById('map'),{center,zoom:15,mapId:'DEMO_MAP_ID',gestureHandling:'greedy',streetViewControl:false,mapTypeControl:false});
      new AdvancedMarkerElement({map,position:center,title:'Event location'});
      window.eventMap=map;
      map.addListener('idle',()=>{const point=map.getCenter();window.eventMapCenter={latitude:point.lat(),longitude:point.lng()};clearTimeout(timeout)});
    }catch{fail()}};
    const load=()=>{const script=document.createElement('script');script.src='https://maps.googleapis.com/maps/api/js?'+new URLSearchParams({key:config.key,loading:'async',callback:'initEventMap',v:'quarterly'});script.async=true;script.onerror=fail;document.head.appendChild(script)};
    document.getElementById('retry-map').addEventListener('click',()=>window.location.reload());
    load();
  </script></body></html>`
}
