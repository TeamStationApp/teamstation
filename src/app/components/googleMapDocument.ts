import type { EventLocation } from '../../common/eventInfo'
import { eventMapDocument } from './eventMapDocument'

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
  const fallback = JSON.stringify(eventMapDocument(location)).replace(
    /</g,
    '\\u003c'
  )
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="origin"><style>
    html,body,#map{height:100%;width:100%;margin:0}
  </style></head><body><div id="map" aria-label="Event location map"></div><script>
    (()=>{
    const config=${config};
    let failed=false;
    const fail=()=>{if(failed)return;failed=true;clearTimeout(timeout);document.open();document.write(${fallback});document.close()};
    window.gm_authFailure=fail;
    const timeout=setTimeout(fail,15000);
    window.initEventMap=async()=>{try{
      if(failed)return;
      const {Map}=await google.maps.importLibrary('maps');
      const {AdvancedMarkerElement}=await google.maps.importLibrary('marker');
      if(failed)return;
      const center={lat:config.latitude,lng:config.longitude};
      const map=new Map(document.getElementById('map'),{center,zoom:15,mapId:'DEMO_MAP_ID',gestureHandling:'greedy',streetViewControl:false,mapTypeControl:false});
      new AdvancedMarkerElement({map,position:center,title:'Event location'});
      window.eventMap=map;
      map.addListener('tilesloaded',()=>{if(!failed)clearTimeout(timeout)});
      map.addListener('idle',()=>{if(failed)return;const point=map.getCenter();window.eventMapCenter={latitude:point.lat(),longitude:point.lng()}});
    }catch{fail()}};
    const load=()=>{const script=document.createElement('script');script.src='https://maps.googleapis.com/maps/api/js?'+new URLSearchParams({key:config.key,loading:'async',callback:'initEventMap',v:'quarterly'});script.async=true;script.onerror=fail;document.head.appendChild(script)};
    load();
    })();
  </script></body></html>`
}
