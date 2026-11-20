<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

type SearchResult = {
  type: 'business' | 'location'
  id: string
  displayName: string | null
  legalName: string | null
  businessId: string | null
  locationCount: number | null
  address: string | null
  matchType: 'exact' | 'prefix' | 'trigram'
}

type BusinessLocation = {
  id: string
  displayName: string | null
  registeredAddress: string | null
  geocodingQuality: string | null
}

type BusinessLocationsResponse = {
  locations: BusinessLocation[]
}

type RegistryResult = {
  cbeNumber: string
  displayName: string
  address: string
  establishmentCount: number
  inScopeEstablishmentCount: number
  mainActivity: string | null
  alreadyImported: boolean
  businessId: string | null
}

type RegistryResponse = {
  results: RegistryResult[]
}

const emit = defineEmits<{
  selectLocation: [locationId: number]
}>()

const query = ref('')
const results = ref<SearchResult[]>([])
const businessLocations = ref<BusinessLocation[]>([])
const selectedBusiness = ref<SearchResult | null>(null)

const registryResults = ref<RegistryResult[]>([])
const isRegistryOpen = ref(false)
const importingCbeNumber = ref<string | null>(null)

const state = ref<'idle' | 'loading' | 'empty' | 'error'>('idle')
const businessLocationsState = ref<
  'idle' | 'loading' | 'empty' | 'error'
>('idle')
const registryState = ref<
  'idle' | 'loading' | 'empty' | 'error'
>('idle')
const registryErrorMessage = ref<string | null>(null)

const isOpen = ref(false)

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let searchController: AbortController | null = null
let businessLocationsController: AbortController | null = null
let registryController: AbortController | null = null
let importController: AbortController | null = null

let searchSequence = 0
let businessLocationsSequence = 0
let registrySequence = 0
let importSequence = 0

const normalizeSearchResponse = (
  value: unknown,
): SearchResult[] => {
  const results = Array.isArray(value)
    ? value
    : (
        value as {
          results?: unknown
        }
      )?.results

  return Array.isArray(results)
    ? (results as SearchResult[])
    : []
}

const normalizeRegistryResponse = (
  value: unknown,
): RegistryResult[] => {
  const results =
    typeof value === 'object' &&
    value !== null &&
    'results' in value
      ? value.results
      : []

  return Array.isArray(results)
    ? (results as RegistryResult[])
    : []
}

const clearSearchRequest = () => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }

  searchController?.abort()
  searchController = null
}

const clearBusinessLocationsRequest = () => {
  businessLocationsController?.abort()
  businessLocationsController = null
}

const clearRegistryRequest = () => {
  registryController?.abort()
  registryController = null
}

const clearImportRequest = () => {
  importController?.abort()
  importController = null
}

const closeDropdown = () => {
  isOpen.value = false
  selectedBusiness.value = null
  businessLocations.value = []
  businessLocationsState.value = 'idle'
  isRegistryOpen.value = false
  registryResults.value = []
  registryState.value = 'idle'
  registryErrorMessage.value = null
  importingCbeNumber.value = null
}

const selectLocation = (rawId: string) => {
  const locationId = Number(rawId)

  if (!Number.isSafeInteger(locationId) || locationId <= 0) {
    state.value = 'error'
    return
  }

  query.value = ''
  results.value = []
  state.value = 'idle'
  closeDropdown()
  emit('selectLocation', locationId)
}

const loadSearchResults = async (value: string) => {
  clearSearchRequest()
  clearRegistryRequest()
  clearImportRequest()

  const trimmedQuery = value.trim()

  if (trimmedQuery.length < 2) {
    results.value = []
    registryResults.value = []
    state.value = 'idle'
    registryState.value = 'idle'
    closeDropdown()
    return
  }

  const controller = new AbortController()
  searchController = controller
  const sequence = ++searchSequence

  isRegistryOpen.value = false
  registryResults.value = []
  registryState.value = 'idle'
  registryErrorMessage.value = null
  state.value = 'loading'
  isOpen.value = true

  try {
    const response = await fetch(
      `/api/search?q=${encodeURIComponent(trimmedQuery)}`,
      {
        signal: controller.signal,
      },
    )

    if (!response.ok) {
      throw new Error(
        `Search failed with status ${response.status}`,
      )
    }

    const data = normalizeSearchResponse(
      await response.json(),
    )

    if (
      controller.signal.aborted ||
      sequence !== searchSequence
    ) {
      return
    }

    results.value = data
    state.value = data.length > 0 ? 'idle' : 'empty'
  } catch {
    if (
      controller.signal.aborted ||
      sequence !== searchSequence
    ) {
      return
    }

    state.value = 'error'
    results.value = []
  } finally {
    if (
      !controller.signal.aborted &&
      sequence === searchSequence
    ) {
      searchController = null
    }
  }
}

const scheduleSearch = () => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void loadSearchResults(query.value)
  }, 250)
}

const toBusinessSearchResult = (
  businessId: string,
  displayName: string,
): SearchResult => ({
  type: 'business',
  id: businessId,
  displayName,
  legalName: displayName,
  businessId,
  locationCount: null,
  address: null,
  matchType: 'exact',
})

const loadBusinessLocations = async (
  business: SearchResult,
) => {
  clearBusinessLocationsRequest()

  const businessId = business.businessId || business.id

  if (!businessId) {
    businessLocationsState.value = 'error'
    return
  }

  const controller = new AbortController()
  businessLocationsController = controller
  const sequence = ++businessLocationsSequence

  selectedBusiness.value = business
  businessLocations.value = []
  businessLocationsState.value = 'loading'
  isRegistryOpen.value = false
  isOpen.value = true

  try {
    const response = await fetch(
      `/api/businesses/${encodeURIComponent(businessId)}/locations`,
      {
        signal: controller.signal,
      },
    )

    if (!response.ok) {
      throw new Error(
        `Business locations failed with status ${response.status}`,
      )
    }

    const data =
      (await response.json()) as BusinessLocationsResponse
    const locations = Array.isArray(data.locations)
      ? data.locations
      : []

    if (
      controller.signal.aborted ||
      sequence !== businessLocationsSequence
    ) {
      return
    }

    if (locations.length === 1) {
      const onlyLocation = locations[0]

      if (onlyLocation) {
        selectLocation(onlyLocation.id)
      }

      return
    }

    businessLocations.value = locations
    businessLocationsState.value =
      locations.length > 0 ? 'idle' : 'empty'
  } catch {
    if (
      controller.signal.aborted ||
      sequence !== businessLocationsSequence
    ) {
      return
    }

    businessLocationsState.value = 'error'
  } finally {
    if (
      !controller.signal.aborted &&
      sequence === businessLocationsSequence
    ) {
      businessLocationsController = null
    }
  }
}

const selectResult = (result: SearchResult) => {
  if (result.type === 'location') {
    selectLocation(result.id)
    return
  }

  void loadBusinessLocations(result)
}

const searchRegistry = async () => {
  const trimmedQuery = query.value.trim()

  if (trimmedQuery.length < 3) {
    registryErrorMessage.value =
      'Enter at least 3 characters to search the registry.'
    return
  }

  clearRegistryRequest()

  const controller = new AbortController()
  registryController = controller
  const sequence = ++registrySequence

  isRegistryOpen.value = true
  selectedBusiness.value = null
  businessLocations.value = []
  businessLocationsState.value = 'idle'
  registryResults.value = []
  registryErrorMessage.value = null
  registryState.value = 'loading'
  isOpen.value = true

  try {
    const response = await fetch(
      `/api/registry/search?q=${encodeURIComponent(trimmedQuery)}`,
      {
        signal: controller.signal,
      },
    )

    if (!response.ok) {
      throw new Error(
        `Registry search failed with status ${response.status}`,
      )
    }

    const data = normalizeRegistryResponse(
      await response.json(),
    )

    if (
      controller.signal.aborted ||
      sequence !== registrySequence
    ) {
      return
    }

    registryResults.value = data
    registryState.value =
      data.length > 0 ? 'idle' : 'empty'
  } catch {
    if (
      controller.signal.aborted ||
      sequence !== registrySequence
    ) {
      return
    }

    registryResults.value = []
    registryState.value = 'error'
    registryErrorMessage.value =
      'Unable to search the company registry.'
  } finally {
    if (
      !controller.signal.aborted &&
      sequence === registrySequence
    ) {
      registryController = null
    }
  }
}

const importRegistryBusiness = async (
  registryResult: RegistryResult,
) => {
  if (
    registryResult.alreadyImported ||
    registryResult.inScopeEstablishmentCount === 0 ||
    importingCbeNumber.value !== null
  ) {
    return
  }

  clearImportRequest()

  const controller = new AbortController()
  importController = controller
  const sequence = ++importSequence

  importingCbeNumber.value = registryResult.cbeNumber
  registryErrorMessage.value = null

  try {
    const response = await fetch('/api/registry/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        cbeNumber: registryResult.cbeNumber,
      }),
    })

    if (
      controller.signal.aborted ||
      sequence !== importSequence
    ) {
      return
    }

    if (response.status === 401) {
      registryErrorMessage.value =
        'Sign in to import a business'
      return
    }

    if (response.status === 404) {
      registryErrorMessage.value =
        'Search again before importing this business.'
      return
    }

    if (response.status === 422) {
      registryErrorMessage.value =
        'No establishments in Flanders/Brussels.'
      return
    }

    if (!response.ok) {
      registryErrorMessage.value =
        'Unable to import this business right now.'
      return
    }

    await loadBusinessLocations(
      toBusinessSearchResult(
        registryResult.businessId ||
          registryResult.cbeNumber,
        registryResult.displayName,
      ),
    )
  } catch {
    if (
      controller.signal.aborted ||
      sequence !== importSequence
    ) {
      return
    }

    registryErrorMessage.value =
      'Unable to import this business right now.'
  } finally {
    if (
      !controller.signal.aborted &&
      sequence === importSequence
    ) {
      importingCbeNumber.value = null
      importController = null
    }
  }
}

const selectRegistryResult = (
  registryResult: RegistryResult,
) => {
  if (registryResult.alreadyImported) {
    const businessId = registryResult.businessId

    if (businessId) {
      void loadBusinessLocations(
        toBusinessSearchResult(
          businessId,
          registryResult.displayName,
        ),
      )
    } else {
      registryErrorMessage.value =
        'This business is already imported but has no local ID.'
    }

    return
  }

  void importRegistryBusiness(registryResult)
}

const backToResults = () => {
  clearBusinessLocationsRequest()
  selectedBusiness.value = null
  businessLocations.value = []
  businessLocationsState.value = 'idle'
  isRegistryOpen.value = false
  registryErrorMessage.value = null
  isOpen.value = true
}

const backToLocalResults = () => {
  clearRegistryRequest()
  clearImportRequest()
  isRegistryOpen.value = false
  registryResults.value = []
  registryState.value = 'idle'
  registryErrorMessage.value = null
  isOpen.value = true
}

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    closeDropdown()
  }
}

onBeforeUnmount(() => {
  clearSearchRequest()
  clearBusinessLocationsRequest()
  clearRegistryRequest()
  clearImportRequest()
})
</script>

<template>
  <div class="relative w-72 max-w-[calc(100vw-2rem)]">
    <label class="sr-only" for="location-search">
      Search businesses and locations
    </label>

    <input
      id="location-search"
      v-model="query"
      type="search"
      autocomplete="off"
      aria-label="Search businesses and locations"
      placeholder="Search businesses or locations"
      class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
      @input="scheduleSearch"
      @focus="isOpen = query.trim().length >= 2"
      @keydown="handleKeydown"
    />

    <div
      v-if="isOpen"
      class="absolute left-0 right-0 top-full z-30 mt-2 max-h-96 overflow-y-auto rounded-md border border-slate-200 bg-white p-2 text-sm shadow-lg"
    >
      <template v-if="selectedBusiness">
        <div class="mb-2 flex items-center justify-between gap-2">
          <p class="font-medium text-slate-900">
            {{ selectedBusiness.displayName || 'Business locations' }}
          </p>
          <button
            type="button"
            class="text-xs text-blue-700 underline"
            @click="backToResults"
          >
            Back to documented results
          </button>
        </div>

        <p
          v-if="businessLocationsState === 'loading'"
          class="p-2 text-slate-500"
          role="status"
        >
          Loading published locations…
        </p>

        <p
          v-else-if="businessLocationsState === 'empty'"
          class="p-2 text-slate-500"
        >
          No published locations for this business
        </p>

        <p
          v-else-if="businessLocationsState === 'error'"
          class="p-2 text-red-700"
          role="alert"
        >
          Unable to load this business's locations.
        </p>

        <div v-else class="space-y-1">
          <button
            v-for="location in businessLocations"
            :key="location.id"
            type="button"
            class="block w-full rounded-md p-2 text-left hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
            @click="selectLocation(location.id)"
          >
            <span class="block font-medium text-slate-900">
              {{ location.displayName || 'Unnamed location' }}
            </span>
            <span
              v-if="location.registeredAddress"
              class="mt-1 block text-xs text-slate-500"
            >
              {{ location.registeredAddress }}
            </span>
          </button>
        </div>
      </template>

      <template v-else-if="isRegistryOpen">
        <div class="mb-2 flex items-center justify-between gap-2">
          <p class="font-semibold text-slate-900">
            Company registry (not yet in Memoria)
          </p>
          <button
            type="button"
            class="text-xs text-blue-700 underline"
            @click="backToLocalResults"
          >
            Back to results
          </button>
        </div>

        <p
          v-if="registryState === 'loading'"
          class="p-2 text-slate-500"
          role="status"
        >
          Searching the company registry…
        </p>

        <p
          v-else-if="registryState === 'empty'"
          class="p-2 text-slate-500"
        >
          Nothing found in the registry
        </p>

        <p
          v-else-if="registryState === 'error'"
          class="p-2 text-red-700"
          role="alert"
        >
          {{ registryErrorMessage || 'Unable to search the company registry.' }}
        </p>

        <p
          v-if="registryErrorMessage && registryState !== 'error'"
          class="mb-2 rounded-md bg-red-50 p-2 text-red-700"
          role="alert"
        >
          {{ registryErrorMessage }}
        </p>

        <div
          v-if="registryState === 'idle'"
          class="space-y-2"
        >
          <button
            v-for="registryResult in registryResults"
            :key="registryResult.cbeNumber"
            type="button"
            class="block w-full rounded-md border border-slate-200 p-2 text-left hover:bg-slate-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="
              importingCbeNumber !== null ||
              registryResult.inScopeEstablishmentCount === 0
            "
            @click="selectRegistryResult(registryResult)"
          >
            <div class="flex items-start justify-between gap-2">
              <span class="font-medium text-slate-900">
                {{ registryResult.displayName }}
              </span>

              <span
                v-if="registryResult.alreadyImported"
                class="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"
              >
                Already in Memoria
              </span>
            </div>

            <span
              v-if="registryResult.address"
              class="mt-1 block text-xs text-slate-500"
            >
              {{ registryResult.address }}
            </span>

            <span
              v-if="registryResult.mainActivity"
              class="mt-1 block text-xs text-slate-600"
            >
              {{ registryResult.mainActivity }}
            </span>

            <span
              v-if="registryResult.inScopeEstablishmentCount > 0"
              class="mt-1 block text-xs text-slate-500"
            >
              {{ registryResult.inScopeEstablishmentCount }}
              locations in Flanders/Brussels
            </span>

            <span
              v-else
              class="mt-1 block text-xs text-slate-400"
            >
              Outside Flanders/Brussels
            </span>

            <span
              v-if="
                importingCbeNumber === registryResult.cbeNumber
              "
              class="mt-2 block text-xs font-medium text-blue-700"
              role="status"
            >
              Importing…
            </span>
          </button>
        </div>
      </template>

      <template v-else>
        <p
          v-if="state === 'loading'"
          class="p-2 text-slate-500"
          role="status"
        >
          Searching…
        </p>

        <p
          v-else-if="state === 'empty'"
          class="p-2 text-slate-500"
        >
          No matches
        </p>

        <p
          v-else-if="state === 'error'"
          class="p-2 text-red-700"
          role="alert"
        >
          Unable to search right now.
        </p>

        <div
          v-else
          class="space-y-1"
        >
          <button
            v-for="result in results"
            :key="`${result.type}-${result.id}`"
            type="button"
            class="block w-full rounded-md p-2 text-left hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
            @click="selectResult(result)"
          >
            <div class="flex items-start gap-2">
              <span
                class="mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                :class="
                  result.type === 'business'
                    ? 'bg-purple-100 text-purple-700'
                    : 'bg-blue-100 text-blue-700'
                "
              >
                {{ result.type }}
              </span>

              <span class="min-w-0 flex-1">
                <span class="block font-medium text-slate-900">
                  {{ result.displayName || 'Unnamed result' }}
                </span>

                <span
                  v-if="
                    result.legalName &&
                    result.legalName !== result.displayName
                  "
                  class="mt-1 block text-xs text-slate-600"
                >
                  {{ result.legalName }}
                </span>

                <span
                  v-if="result.address"
                  class="mt-1 block text-xs text-slate-500"
                >
                  {{ result.address }}
                </span>

                <span
                  v-if="
                    result.type === 'business' &&
                    result.locationCount !== null &&
                    result.locationCount !== undefined
                  "
                  class="mt-1 block text-xs text-slate-500"
                >
                  {{ result.locationCount }}
                  published location{{
                    result.locationCount === 1 ? '' : 's'
                  }}
                </span>
              </span>
            </div>
          </button>
        </div>

        <button
          v-if="
            query.trim().length >= 3 &&
            state !== 'loading' &&
            state !== 'error' &&
            results.length < 3
          "
          type="button"
          class="mt-2 w-full border-t border-slate-200 px-2 pt-3 text-left text-xs font-medium text-blue-700 hover:text-blue-900 focus:outline-none"
          @click="searchRegistry"
        >
          Not found? Search the company registry
        </button>
      </template>
    </div>
  </div>
</template>