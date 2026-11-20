<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource } from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { LogoControl } from '@maptoolkit/maplibre-logo-control'
import '@maptoolkit/maplibre-logo-control/style.css'
import 'maplibre-gl/dist/maplibre-gl.css'

import type { FeatureCollection, Point } from 'geojson'


type LocationProperties = {
  locationId: number
  legalBusinessName: string | null
  locationName: string | null
  businessVerificationStatus: string | null
  geocodingQuality: string
  hasPublishedPriceObservation: boolean
}

type LocationFeatureCollection = FeatureCollection<
  Point,
  LocationProperties
>

const emit = defineEmits<{
  locationSelected: [locationId: number]
}>()

const mapContainer = ref<HTMLElement | null>(null)
const isLoading = ref(false)
const errorMessage = ref<string | null>(null)
const featureCount = ref(0)

const emptyFeatureCollection = (): LocationFeatureCollection => ({
  type: 'FeatureCollection',
  features: [],
})

let map: maplibregl.Map | null = null
let activeController: AbortController | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let requestSequence = 0

const sourceId = 'memoria-locations'
const layerId = 'memoria-location-markers'

const updateLocationSource = (data: LocationFeatureCollection) => {
  featureCount.value = data.features.length

  const source = map?.getSource(sourceId) as GeoJSONSource | undefined

    if (source) {
        source.setData(data)
    }
}

const fetchLocations = async () => {
  if (!map) {
    return
  }

  activeController?.abort()
  const controller = new AbortController()
  activeController = controller
  const sequence = requestSequence

  isLoading.value = true
  errorMessage.value = null

  const bounds = map.getBounds()
  const params = new URLSearchParams({
    west: String(bounds.getWest()),
    south: String(bounds.getSouth()),
    east: String(bounds.getEast()),
    north: String(bounds.getNorth()),
  })

  try {
    const response = await fetch(`/api/locations?${params.toString()}`, {
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Location request failed with status ${response.status}`)
    }

    const data = (await response.json()) as LocationFeatureCollection

    if (controller.signal.aborted || sequence !== requestSequence) {
      return
    }

    if (
      data.type !== 'FeatureCollection' ||
      !Array.isArray(data.features)
    ) {
      throw new Error('Location response was not a FeatureCollection')
    }

    updateLocationSource(data)
  } catch (error) {
    if (controller.signal.aborted || sequence !== requestSequence) {
      return
    }

    errorMessage.value =
      error instanceof Error ? error.message : 'Unable to load locations'
    updateLocationSource(emptyFeatureCollection())
  } finally {
    if (!controller.signal.aborted && sequence === requestSequence) {
      isLoading.value = false
    }
  }
}

const scheduleLocationRefresh = () => {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void fetchLocations()
  }, 250)
}

const handleMarkerClick = (
  event: maplibregl.MapLayerMouseEvent,
) => {
  const feature = event.features?.[0]
  const rawLocationId = feature?.properties?.locationId
    

  if (rawLocationId === undefined || rawLocationId === null) {
    return
  }

  const parsedLocationId = Number(rawLocationId)

  if (
    !Number.isSafeInteger(parsedLocationId) ||
    parsedLocationId <= 0
  ) {
    return
   }

  emit('locationSelected', parsedLocationId)
}

const handleMapLoad = () => {
  if (!map) {
    return
  }

  map.addSource(sourceId, {
    type: 'geojson',
    data: emptyFeatureCollection(),
  })

  map.addLayer({
    id: layerId,
    type: 'circle',
    source: sourceId,
    paint: {
      'circle-color': '#2563eb',
      'circle-radius': 7,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  })

  map.on('click', layerId, handleMarkerClick)
  map.on('mouseenter', layerId, () => {
    map?.getCanvas().style.setProperty('cursor', 'pointer')
  })
  map.on('mouseleave', layerId, () => {
    map?.getCanvas().style.removeProperty('cursor')
  })

  void fetchLocations()
}

const handleMapError = (event: maplibregl.ErrorEvent) => {
  console.error('MapLibre error:', event.error)
}

onMounted(() => {
  if (!mapContainer.value) {
    return
  }

  maplibregl.setWorkerUrl(maplibreWorkerUrl)


  map = new maplibregl.Map({
    container: mapContainer.value,
    style: 'https://styles.maptoolkit.org/summer.json',
    center: [4.45, 51.2],
    zoom: 10,
    attributionControl: {
      customAttribution: '',
      compact: false,
    },
  })

  map.addControl(new maplibregl.NavigationControl(), 'top-right')
  map.addControl(new LogoControl(), 'bottom-left')
  map.on('load', handleMapLoad)
  map.on('moveend', scheduleLocationRefresh)

  requestAnimationFrame(() => {
    map?.resize()
  })
})

onBeforeUnmount(() => {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }

  activeController?.abort()
  activeController = null

  if (map) {
    map.off('load', handleMapLoad)
    map.off('moveend', scheduleLocationRefresh)
    map.off('click', layerId, handleMarkerClick)
    map.remove()
    map = null
  }
})
</script>

<template>
  <section class="relative h-full min-h-[32rem] w-full overflow-hidden">
    <div
      ref="mapContainer"
      class="absolute inset-0 h-full w-full"
      aria-label="Memoria location map"
    />

    <div
      class="pointer-events-none absolute right-4 top-4 z-10 max-w-xs space-y-2"
      aria-live="polite"
    >
      <p
        v-if="isLoading"
        class="rounded-md bg-white/90 px-3 py-2 text-sm text-slate-600 shadow-sm"
      >
        Loading locations…
      </p>

      <p
        v-else-if="errorMessage"
        class="rounded-md bg-white/95 px-3 py-2 text-sm text-red-700 shadow-sm"
      >
        Unable to load locations.
      </p>

      <p
        v-else-if="featureCount === 0"
        class="rounded-md bg-white/90 px-3 py-2 text-sm text-slate-600 shadow-sm"
      >
        No verified locations in this view.
      </p>
    </div>
  </section>
</template>