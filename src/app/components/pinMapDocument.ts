import sdk from '../assets/leafletRuntime.json'

/** Where a map is centred, the pin it shows, and how it is drawn. */
export interface PinMapSettings {
  latitude: number
  longitude: number
  tileUrl: string
  googleMapsApiKey?: string
  /** Whether the pin can be dragged. */
  editable: boolean
}

/** What every platform's PinMap takes. */
export interface PinMapProps {
  settings: PinMapSettings
  /** Where the pin was dragged to. */
  onMove?: (pin: { latitude: number; longitude: number }) => void
  /** How long Android waits for Google's map before drawing the web one. */
  fallbackAfterMs?: number
}

/** The message a map posts when its pin has been dragged somewhere. */
export interface PinMoved {
  type: 'teamstation:pinMoved'
  latitude: number
  longitude: number
}

/** Reads a posted message as a moved pin, or nothing. */
export function pinMovedOf(data: unknown): PinMoved | undefined {
  let value = data
  if (typeof value === 'string')
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  if (value == null || typeof value !== 'object') return undefined
  const moved = value as Partial<PinMoved>
  if (
    moved.type !== 'teamstation:pinMoved' ||
    typeof moved.latitude !== 'number' ||
    typeof moved.longitude !== 'number' ||
    !Number.isFinite(moved.latitude) ||
    !Number.isFinite(moved.longitude) ||
    Math.abs(moved.latitude) > 90 ||
    Math.abs(moved.longitude) > 180
  )
    return undefined
  return {
    type: moved.type,
    latitude: moved.latitude,
    longitude: moved.longitude
  }
}

function checked(settings: PinMapSettings): void {
  if (
    !Number.isFinite(settings.latitude) ||
    !Number.isFinite(settings.longitude) ||
    Math.abs(settings.latitude) > 90 ||
    Math.abs(settings.longitude) > 180
  )
    throw new Error('The place could not be located.')
}

/**
 * Posts a moved pin to whoever holds the map: the web page that framed it,
 * or the app's WebView. Shared by both documents.
 */
const POST = `const post=(lat,lng)=>{const message={type:'teamstation:pinMoved',latitude:lat,longitude:lng};if(window.ReactNativeWebView!=null)window.ReactNativeWebView.postMessage(JSON.stringify(message));else if(window.parent!==window)window.parent.postMessage(message,'*')};`

/** The Leaflet map: the tiles, and a pin that drags when it may. */
export function leafletPinDocument(settings: PinMapSettings): string {
  checked(settings)
  const config = JSON.stringify({
    latitude: settings.latitude,
    longitude: settings.longitude,
    tileUrl: settings.tileUrl,
    editable: settings.editable
  }).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="origin"><style>${sdk.css}
    html,body,#map{height:100%;width:100%;margin:0} .pin-marker{background:#c62828;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px #0006;width:22px;height:22px}
  </style></head><body><div id="map" aria-label="Field location map"></div><script>${sdk.js}</script><script>
    const config=${config};${POST}
    const map=L.map('map',{scrollWheelZoom:false}).setView([config.latitude,config.longitude],17);
    L.tileLayer(config.tileUrl,{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
    const marker=L.marker([config.latitude,config.longitude],{draggable:config.editable,icon:L.divIcon({className:'pin-marker',iconSize:[22,22],iconAnchor:[11,11]})}).addTo(map);
    marker.on('dragend',()=>{const point=marker.getLatLng();post(point.lat,point.lng)});
    window.pinMap=map;window.pinMarker=marker;
  </script></body></html>`
}

/** Google's map, with a draggable advanced marker; Leaflet when it fails. */
export function googlePinDocument(settings: PinMapSettings): string {
  checked(settings)
  if (settings.googleMapsApiKey == null || settings.googleMapsApiKey === '')
    throw new Error('Google Maps is not configured.')
  const config = JSON.stringify({
    latitude: settings.latitude,
    longitude: settings.longitude,
    key: settings.googleMapsApiKey,
    editable: settings.editable
  }).replace(/</g, '\\u003c')
  const fallback = JSON.stringify(leafletPinDocument(settings)).replace(
    /</g,
    '\\u003c'
  )
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="origin"><style>
    html,body,#map{height:100%;width:100%;margin:0}
  </style></head><body><div id="map" aria-label="Field location map"></div><script>
    (()=>{
    const config=${config};${POST}
    let failed=false;
    const fail=()=>{if(failed)return;failed=true;clearTimeout(timeout);document.open();document.write(${fallback});document.close()};
    window.gm_authFailure=fail;
    const timeout=setTimeout(fail,15000);
    window.initPinMap=async()=>{try{
      if(failed)return;
      const {Map}=await google.maps.importLibrary('maps');
      const {AdvancedMarkerElement}=await google.maps.importLibrary('marker');
      if(failed)return;
      const center={lat:config.latitude,lng:config.longitude};
      const map=new Map(document.getElementById('map'),{center,zoom:18,mapId:'DEMO_MAP_ID',gestureHandling:'greedy',streetViewControl:false,mapTypeControl:false,mapTypeId:'hybrid'});
      const marker=new AdvancedMarkerElement({map,position:center,title:'Field location',gmpDraggable:config.editable});
      marker.addListener('dragend',()=>{const point=marker.position;post(typeof point.lat==='function'?point.lat():point.lat,typeof point.lng==='function'?point.lng():point.lng)});
      window.pinMap=map;window.pinMarker=marker;
      map.addListener('tilesloaded',()=>{if(!failed)clearTimeout(timeout)});
    }catch{fail()}};
    const script=document.createElement('script');script.src='https://maps.googleapis.com/maps/api/js?'+new URLSearchParams({key:config.key,loading:'async',callback:'initPinMap',v:'quarterly'});script.async=true;script.onerror=fail;document.head.appendChild(script);
    })();
  </script></body></html>`
}

/** Google's map when there is a key, Leaflet's otherwise. */
export function pinMapDocument(settings: PinMapSettings): string {
  return settings.googleMapsApiKey == null || settings.googleMapsApiKey === ''
    ? leafletPinDocument(settings)
    : googlePinDocument(settings)
}
