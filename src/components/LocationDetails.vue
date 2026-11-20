<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ContributePriceModal from './ContributePriceModal.vue'

type RegisteredAddress = {
  address: string | null
  streetName: string | null
  houseNumber: string | null
  postcode: string | null
  municipality: string | null
  countryCode: string | null
}

type GeocodingEvidence = {
  provider: string | null
  providerResponseId: string | null
  formattedAddress: string | null
  locationType: string | null
  quality: string | null
  coordinates: {
    latitude: number
    longitude: number
  } | null
  evidenceNote: string | null
}

type LocationDetailsResponse = {
  id: number
  legalBusinessName: string | null
  registeredAddress: RegisteredAddress
  establishmentIdentifier: string | null
  locationAlias: string | null
  businessVerificationStatus: string | null
  geocoding: GeocodingEvidence | null
}

type Offering = {
  id: number
  service: {
    id: number
    name: string
  }
  category: {
    id: number
    name: string
  }
  verificationStatus: string | null
  source: string | null
  sourceUrl: string | null
  priceObservationCount?: number | null
}

type OfferingsResponse = {
  offerings: Offering[]
}

type PriceObservation = {
  id: string
  version: number
  minAmount: string | null
  maxAmount: string | null
  currencyCode: string
  priceType: string
  priceBasis: string
  observedAt: string
  notes: string | null
  verificationStatus: string | null
  isMine: boolean
}

type OfferingPricesResponse = {
  offering: Offering
  prices: PriceObservation[]
}

type Me = {
  id: string
  email: string | null
  displayName: string | null
  isCurator: boolean
}

const props = defineProps<{
  selectedLocationId: number | null
  me: Me | null
}>()

const emit = defineEmits<{
  authInvalidated: []
}>()

const location = ref<LocationDetailsResponse | null>(null)
const offerings = ref<Offering[]>([])
const selectedOfferingId = ref<number | null>(null)
const contributionOfferingId = ref<number | null>(null)
const editingPrice = ref<PriceObservation | null>(null)
const deletingPriceId = ref<string | null>(null)
const prices = ref<PriceObservation[]>([])
const selectedPriceOffering = ref<Offering | null>(null)
const toastMessage = ref<string | null>(null)

const isLoadingLocation = ref(false)
const isLoadingPrices = ref(false)
const locationError = ref<string | null>(null)
const priceError = ref<string | null>(null)

let locationController: AbortController | null = null
let priceController: AbortController | null = null
let locationRequestSequence = 0
let priceRequestSequence = 0
let offeringsController: AbortController | null = null
let offeringsRequestSequence = 0


const openContributionModal = (
  offeringId: number,
  price: PriceObservation | null = null,
) => {
  if (props.me !== null) {
    contributionOfferingId.value = offeringId
    editingPrice.value = price
  }
}

const closeContributionModal = () => {
  contributionOfferingId.value = null
  editingPrice.value = null
}


const fetchJson = async <T>(
  url: string,
  signal: AbortSignal,
): Promise<T> => {
  const response = await fetch(url, { signal })

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }

  return (await response.json()) as T
}

const formatAddress = (address: RegisteredAddress) => {
  const structuredAddress = [
    [address.streetName, address.houseNumber].filter(Boolean).join(' '),
    address.postcode,
    address.municipality,
    address.countryCode,
  ].filter(Boolean)

  return structuredAddress.length > 0
    ? structuredAddress.join(', ')
    : address.address || 'Address unavailable'
}

const formatDate = (value: string) => {
  const date = new Date(value)

  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
      }).format(date)
}

const formatAmount = (price: PriceObservation) => {
  const min = price.minAmount
  const max = price.maxAmount
  const currency = price.currencyCode

  if (min === null && max === null) {
    return 'Amount unavailable'
  }

  if (min !== null && max !== null && min !== max) {
    return `${min}–${max} ${currency}`
  }

  return `${min ?? max} ${currency}`
}

const selectedOffering = computed(() =>
  offerings.value.find(
    (offering) => offering.id === selectedOfferingId.value,
  ) ?? null,
)

const loadPrices = async (offeringId: number | null) => {
  priceController?.abort()
  priceController = null
  const sequence = ++priceRequestSequence

  prices.value = []
  selectedPriceOffering.value = null
  priceError.value = null

  if (offeringId === null) {
    isLoadingPrices.value = false
    return
  }

  const controller = new AbortController()
  priceController = controller
  isLoadingPrices.value = true

  try {
    const data = await fetchJson<OfferingPricesResponse>(
      `/api/offerings/${offeringId}/prices`,
      controller.signal,
    )

    if (
      controller.signal.aborted ||
      sequence !== priceRequestSequence ||
      offeringId !== selectedOfferingId.value
    ) {
      return
    }

    selectedPriceOffering.value = data.offering
    prices.value = Array.isArray(data.prices) ? data.prices : []
  } catch (error) {
    if (
      controller.signal.aborted ||
      sequence !== priceRequestSequence
    ) {
      return
    }

    priceError.value =
      error instanceof Error
        ? error.message
        : 'Unable to load prices'
  } finally {
    if (
      !controller.signal.aborted &&
      sequence === priceRequestSequence
    ) {
      isLoadingPrices.value = false
    }
  }
}

const loadLocation = async (locationId: number | null) => {
  locationController?.abort()
  priceController?.abort()
  locationController = null
  priceController = null

  const sequence = ++locationRequestSequence
  priceRequestSequence += 1

  location.value = null
  offerings.value = []
  selectedOfferingId.value = null
  prices.value = []
  selectedPriceOffering.value = null
  locationError.value = null
  priceError.value = null

  if (locationId === null) {
    isLoadingLocation.value = false
    return
  }

  const controller = new AbortController()
  locationController = controller
  isLoadingLocation.value = true

  try {
    const [locationData, offeringsData] = await Promise.all([
      fetchJson<LocationDetailsResponse>(
        `/api/locations/${locationId}`,
        controller.signal,
      ),
      fetchJson<OfferingsResponse>(
        `/api/locations/${locationId}/offerings`,
        controller.signal,
      ),
    ])

    if (
      controller.signal.aborted ||
      sequence !== locationRequestSequence ||
      locationId !== props.selectedLocationId
    ) {
      return
    }

    location.value = locationData
    offerings.value = Array.isArray(offeringsData.offerings)
      ? offeringsData.offerings
      : []
  } catch (error) {
    if (
      controller.signal.aborted ||
      sequence !== locationRequestSequence
    ) {
      return
    }

    locationError.value =
      error instanceof Error
        ? error.message
        : 'Unable to load location details'
  } finally {
    if (
      !controller.signal.aborted &&
      sequence === locationRequestSequence
    ) {
      isLoadingLocation.value = false
    }
  }
}

const refreshOfferings = async () => {
  const locationId = props.selectedLocationId

  if (locationId === null) {
    return
  }

  offeringsController?.abort()

  const controller = new AbortController()
  offeringsController = controller
  const sequence = ++offeringsRequestSequence

  try {
    const data = await fetchJson<OfferingsResponse>(
      `/api/locations/${locationId}/offerings`,
      controller.signal,
    )

    if (
      controller.signal.aborted ||
      sequence !== offeringsRequestSequence ||
      locationId !== props.selectedLocationId
    ) {
      return
    }

    offerings.value = Array.isArray(data.offerings)
      ? data.offerings
      : []
  } catch (error) {
    if (
      controller.signal.aborted ||
      sequence !== offeringsRequestSequence
    ) {
      return
    }

    locationError.value =
      error instanceof Error
        ? error.message
        : 'Unable to refresh offerings'
  } finally {
    if (
      !controller.signal.aborted &&
      sequence === offeringsRequestSequence
    ) {
      offeringsController = null
    }
  }
}

watch(
  () => props.selectedLocationId,
  (locationId) => {
    void loadLocation(locationId)
  },
  { immediate: true },
)

watch(selectedOfferingId, (offeringId) => {
  void loadPrices(offeringId)
})

const refreshAfterPriceMutation = async (
  offeringId: number,
  message: string | null = null,
) => {
  closeContributionModal()

  if (message) {
    toastMessage.value = message
  }

  await Promise.all([
    refreshOfferings(),
    loadPrices(offeringId),
  ])

  if (message) {
    window.setTimeout(() => {
      toastMessage.value = null
    }, 3500)
  }
}

const refreshSubmittedOfferingPrices = () => {
  const offeringId = contributionOfferingId.value

  if (offeringId !== null) {
    void refreshAfterPriceMutation(
      offeringId,
      'Submitted — pending review',
    )
  } else {
    closeContributionModal()
  }
}

const handleContributionUnauthorized = () => {
  closeContributionModal()
  emit('authInvalidated')
}

const reloadSelectedPrices = () => {
  void loadPrices(selectedOfferingId.value)
}

const hidePrice = async (price: PriceObservation) => {
  if (
    props.me === null ||
    deletingPriceId.value !== null
  ) {
    return
  }

  if (
    !window.confirm(
      'Hide this price? It will no longer be public.',
    )
  ) {
    return
  }

  deletingPriceId.value = price.id
  priceError.value = null

  try {
    const response = await fetch(
      `/api/prices/${encodeURIComponent(price.id)}`,
      {
        method: 'DELETE',
      },
    )

    if (response.status === 401) {
      emit('authInvalidated')
      return
    }

    if (response.status === 403) {
      priceError.value =
        'You are not allowed to hide this price.'
      return
    }

    if (response.status === 404) {
      priceError.value = 'This price is no longer available.'
      return
    }

    if (!response.ok) {
      priceError.value = 'Unable to hide this price.'
      return
    }

    const offeringId = selectedOfferingId.value

    if (offeringId !== null) {
      await refreshAfterPriceMutation(offeringId)
    }
  } catch {
    priceError.value = 'Unable to hide this price.'
  } finally {
    deletingPriceId.value = null
  }
}

onBeforeUnmount(() => {
  locationRequestSequence +=1
  priceRequestSequence +=1
  offeringsRequestSequence += 1
  locationController?.abort()
  priceController?.abort()
  offeringsController?.abort()
})
</script>

<template>
  <section class="min-h-full p-4 text-sm text-slate-800">
    <div
      v-if="selectedLocationId === null"
      class="flex min-h-48 items-center justify-center text-center text-slate-500"
    >
      Select a verified location on the map to inspect its directory details.
    </div>

    <div
      v-else-if="isLoadingLocation"
      class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-slate-600"
      role="status"
    >
      Loading location details…
    </div>

    <div
      v-else-if="locationError"
      class="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700"
      role="alert"
    >
      Unable to load this location.
    </div>

    <template v-else-if="location">
      <p
        v-if="toastMessage"
        class="fixed right-4 top-4 z-30 rounded-md bg-emerald-700 px-3 py-2 text-sm text-white shadow-sm"
        role="status"
      >
        {{ toastMessage }}
      </p>
        <header class="border-b border-slate-200 pb-4">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Directory identity
        </p>

        <div class="mt-1 flex flex-wrap items-center gap-2">
            <h2 class="text-lg font-semibold text-slate-950">
            {{ location.locationAlias || location.legalBusinessName || 'Unnamed location' }}
            </h2>

            <span
            v-if="location.businessVerificationStatus === 'registry_identified'"
            class="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
            >
            Registry data, not yet verified
            </span>
        </div>

        <p
            v-if="location.legalBusinessName"
            class="mt-1 text-slate-600"
        >
            {{ location.legalBusinessName }}
        </p>

        <p
            v-if="location.businessVerificationStatus === 'registry_identified'"
            class="mt-2 text-xs text-slate-500"
        >
            Offerings and prices are community-submitted.
        </p>
        </header>
      <dl class="space-y-3 border-b border-slate-200 py-4">
        <div>
          <dt class="font-medium text-slate-500">Registered address</dt>
          <dd class="mt-1">{{ formatAddress(location.registeredAddress) }}</dd>
        </div>
        <div>
          <dt class="font-medium text-slate-500">Establishment identifier</dt>
          <dd class="mt-1">
            {{ location.establishmentIdentifier || 'Not available' }}
          </dd>
        </div>
        <div>
          <dt class="font-medium text-slate-500">Business verification</dt>
          <dd class="mt-1">
            {{ location.businessVerificationStatus || 'Not available' }}
          </dd>
        </div>
      </dl>

      <section
        v-if="location.geocoding"
        class="border-b border-slate-200 py-4"
      >
        <p class="font-semibold text-slate-950">Geocoding evidence</p>
        <dl class="mt-3 space-y-2">
          <div>
            <dt class="font-medium text-slate-500">Provider</dt>
            <dd>{{ location.geocoding.provider || 'Not available' }}</dd>
          </div>
          <div>
            <dt class="font-medium text-slate-500">Quality</dt>
            <dd>{{ location.geocoding.quality || 'Not available' }}</dd>
          </div>
          <div v-if="location.geocoding.formattedAddress">
            <dt class="font-medium text-slate-500">Formatted address</dt>
            <dd>{{ location.geocoding.formattedAddress }}</dd>
          </div>
          <div v-if="location.geocoding.evidenceNote">
            <dd class="text-xs text-slate-500">
              {{ location.geocoding.evidenceNote }}
            </dd>
          </div>
        </dl>
      </section>

      <section class="py-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="font-semibold text-slate-950">Offering evidence</p>
            <p class="mt-1 text-xs text-slate-500">
              Published services reported for this location.
            </p>
          </div>
          <span class="text-xs text-slate-500">
            {{ offerings.length }}
          </span>
        </div>

        <p
          v-if="offerings.length === 0"
          class="mt-3 rounded-md bg-slate-50 p-3 text-slate-500"
        >
          No published offerings.
        </p>

        <div v-else class="mt-3 space-y-2">
          <button
            v-for="offering in offerings"
            :key="offering.id"
            type="button"
            class="w-full rounded-md border p-3 text-left transition"
            :class="
              selectedOfferingId === offering.id
                ? 'border-blue-500 bg-blue-50'
                : 'border-slate-200 bg-white hover:border-slate-400'
            "
            @click="selectedOfferingId = offering.id"
          >
            <span class="font-medium text-slate-950">
              {{ offering.service.name }}
            </span>
            <span class="mt-1 block text-xs text-slate-600">
              {{ offering.category.name }}
              · {{ offering.verificationStatus || 'Verification unavailable' }}
            </span>
            <span
              v-if="
                offering.priceObservationCount !== null &&
                offering.priceObservationCount !== undefined &&
                offering.priceObservationCount > 0
              "
              class="mt-1 block text-xs text-slate-500"
            >
              {{ offering.priceObservationCount }}
              unverified price observation{{ offering.priceObservationCount === 1 ? '' : 's' }}
            </span>
            <span class="mt-2 block text-xs text-slate-500">
              Source: {{ offering.source || 'Not available' }}
            </span>
            <a
              v-if="offering.sourceUrl"
              :href="offering.sourceUrl"
              target="_blank"
              rel="noreferrer"
              class="mt-1 block truncate text-xs text-blue-700 underline"
              @click.stop
            >
              {{ offering.sourceUrl }}
            </a>
            <button
              v-if="me !== null"
              type="button"
              class="mt-3 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
              @click.stop="openContributionModal(offering.id)"
            >
              Add a price
            </button>
          </button>
        </div>
      </section>

      <section
        v-if="selectedOffering"
        class="border-t border-slate-200 pt-4"
      >
        <p class="font-semibold text-slate-950">
          {{ selectedPriceOffering?.service.name || selectedOffering.service.name }}
          prices
        </p>

        <p
          v-if="isLoadingPrices"
          class="mt-3 rounded-md bg-slate-50 p-3 text-slate-500"
          role="status"
        >
          Loading published prices…
        </p>

        <p
          v-else-if="priceError"
          class="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-red-700"
          role="alert"
        >
          Unable to load prices.
        </p>

        <p
          v-else-if="prices.length === 0"
          class="mt-3 rounded-md bg-slate-50 p-3 text-slate-500"
        >
          No published price observations.
        </p>

        <div v-else class="mt-3 space-y-3">
          <article
            v-for="price in prices"
            :key="price.id"
            class="rounded-md border border-slate-200 p-3"
          >
            <p class="font-medium text-slate-950">
              {{ formatAmount(price) }}
            </p>
            <dl class="mt-2 space-y-1 text-xs text-slate-600">
              <div>
                <dt class="inline font-medium">Type:</dt>
                <dd class="inline"> {{ price.priceType }}</dd>
              </div>
              <div>
                <dt class="inline font-medium">Basis:</dt>
                <dd class="inline"> {{ price.priceBasis }}</dd>
              </div>
              <div>
                <dt class="inline font-medium">Observed:</dt>
                <dd class="inline"> {{ formatDate(price.observedAt) }}</dd>
              </div>
              <div>
                <dt class="inline font-medium">Verification:</dt>
                <dd class="inline">
                  {{ price.verificationStatus || 'Not available' }}
                </dd>
              </div>
            </dl>
            <p
              v-if="price.notes"
              class="mt-2 text-xs text-slate-500"
            >
              {{ price.notes }}
            </p>
            <div
                v-if="me !== null && price.isMine"
                class="mt-3 flex gap-2"
            >
                <button
                    type="button"
                    class="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    @click="
                    openContributionModal(
                        selectedOfferingId!,
                        price,
                    )
                    "
                >
                    Edit
                </button>

                <button
                    type="button"
                    class="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    :disabled="deletingPriceId === price.id"
                    @click="hidePrice(price)"
                >
                    {{ deletingPriceId === price.id ? 'Hiding…' : 'Hide' }}
                </button>
            </div>
          </article>
        </div>
      </section>
    </template>
    <ContributePriceModal
        :offering-id="contributionOfferingId"
        :editing="editingPrice"
        @close="closeContributionModal"
        @submitted="refreshSubmittedOfferingPrices"
        @unauthorized="handleContributionUnauthorized"
        @reload-requested="reloadSelectedPrices"
    />
  </section>
</template>