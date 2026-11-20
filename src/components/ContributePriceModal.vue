<script setup lang="ts">
    import { computed, ref, watch } from 'vue'

    type EditingPrice = {
    id: string
    version: number
    minAmount: string | null
    maxAmount: string | null
    currencyCode: string
    priceType: string
    priceBasis: string
    observedAt: string
    notes: string | null
    }

    const props = defineProps<{
    offeringId: number | null
    editing: EditingPrice | null
    }>()

    const emit = defineEmits<{
    close: []
    submitted: []
    unauthorized: []
    reloadRequested: []
    }>()

    const amount = ref('')
    const currencyCode = ref('EUR')
    const priceType = ref<'fixed' | 'range' | 'from'>('fixed')
    const maxAmount = ref('')
    const priceBasis = ref('')
    const observedAt = ref(new Date().toISOString().slice(0, 10))
    const notes = ref('')
    const isSubmitting = ref(false)
    const errorMessage = ref<string | null>(null)

    const isVisible = computed(() => props.offeringId !== null)

    const isEditing = computed(() => props.editing !== null)

    const title = computed(() =>
    isEditing.value ? 'Edit price' : 'Add a price',
    )

    const submitLabel = computed(() =>
    isEditing.value ? 'Save changes' : 'Submit price',
    )

    watch(
    () => [props.offeringId, props.editing] as const,
    ([offeringId, editing]) => {
        if (offeringId === null) {
        return
        }

        if (editing) {
        amount.value = editing.minAmount ?? ''
        currencyCode.value = editing.currencyCode
        priceType.value = editing.priceType as
            | 'fixed'
            | 'range'
            | 'from'
        maxAmount.value = editing.maxAmount ?? ''
        priceBasis.value = editing.priceBasis
        observedAt.value = editing.observedAt
        notes.value = editing.notes ?? ''
        } else {
        amount.value = ''
        currencyCode.value = 'EUR'
        priceType.value = 'fixed'
        maxAmount.value = ''
        priceBasis.value = ''
        observedAt.value = new Date().toISOString().slice(0, 10)
        notes.value = ''
        }

        errorMessage.value = null
        isSubmitting.value = false
    },
    { immediate: true },
    )

    const close = () => {
    if (!isSubmitting.value) {
        emit('close')
    }
    }

    const submit = async () => {
    errorMessage.value = null

    const parsedAmount = Number(amount.value)
    const parsedMaxAmount = Number(maxAmount.value)

    if (
        !Number.isFinite(parsedAmount) ||
        parsedAmount < 0 ||
        !priceBasis.value.trim() ||
        !observedAt.value
    ) {
        errorMessage.value = 'Enter an amount, price basis, and observation date.'
        return
    }

    if (
        priceType.value === 'range' &&
        (!Number.isFinite(parsedMaxAmount) ||
        parsedMaxAmount < parsedAmount)
    ) {
        errorMessage.value =
        'Enter a maximum amount greater than or equal to the amount.'
        return
    }

    if (props.offeringId === null) {
        return
    }

    const editing = props.editing
    const url = editing
        ? `/api/prices/${encodeURIComponent(editing.id)}`
        : '/api/prices'

    isSubmitting.value = true

    try {
        const response = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            ...(editing
            ? { expectedVersion: editing.version }
            : { offeringId: props.offeringId }),
            minAmount: parsedAmount,
            ...(priceType.value === 'range'
            ? { maxAmount: parsedMaxAmount }
            : {}),
            currencyCode: currencyCode.value,
            priceType: priceType.value,
            priceBasis: priceBasis.value.trim(),
            observedAt: observedAt.value,
            ...(notes.value.trim()
            ? { notes: notes.value.trim() }
            : {}),
        }),
        })

        if (response.status === 401) {
        emit('close')
        emit('unauthorized')
        return
        }

        if (response.status === 409) {
        errorMessage.value =
            'This price was changed by someone else. Reload and try again.'
        return
        }

        if (response.status === 400) {
        errorMessage.value = 'Please check the submitted price details.'
        return
        }

        if (response.status === 429) {
        errorMessage.value =
            'Too many submissions. Please try again later.'
        return
        }

        if (!response.ok) {
        errorMessage.value = 'Unable to save the price.'
        return
        }

        emit('submitted')
        emit('close')
    } catch {
        errorMessage.value = 'Unable to save the price.'
    } finally {
        isSubmitting.value = false
    }
}
</script>


<template>
  <div
    v-if="isVisible"
    class="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/40 p-4"
    role="presentation"
    @click.self="close"
  >
    <section
      class="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-5 shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="contribute-price-title"
    >
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Offering evidence
          </p>
          <h2
            id="contribute-price-title"
            class="mt-1 text-lg font-semibold text-slate-950"
          >
            {{ title }}
          </h2>
        </div>
        <button
          type="button"
          class="text-xl leading-none text-slate-500 hover:text-slate-900"
          aria-label="Close"
          @click="close"
        >
          ×
        </button>
      </div>

      <form class="mt-4 space-y-4" @submit.prevent="submit">
        <div>
          <label
            for="price-amount"
            class="block font-medium text-slate-700"
          >
            Amount
          </label>
          <input
            id="price-amount"
            v-model="amount"
            type="number"
            min="0"
            step="0.01"
            required
            class="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label
            for="price-currency"
            class="block font-medium text-slate-700"
          >
            Currency
          </label>
          <select
            id="price-currency"
            v-model="currencyCode"
            class="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          >
            <option value="EUR">EUR</option>
          </select>
        </div>

        <fieldset>
          <legend class="font-medium text-slate-700">Price type</legend>
          <div class="mt-2 flex gap-4 text-sm">
            <label class="flex items-center gap-2">
              <input v-model="priceType" type="radio" value="fixed" />
              Fixed
            </label>
            <label class="flex items-center gap-2">
              <input v-model="priceType" type="radio" value="range" />
              Range
            </label>
            <label class="flex items-center gap-2">
              <input v-model="priceType" type="radio" value="from" />
              From
            </label>
          </div>
        </fieldset>

        <div v-if="priceType === 'range'">
          <label
            for="price-max-amount"
            class="block font-medium text-slate-700"
          >
            Maximum amount
          </label>
          <input
            id="price-max-amount"
            v-model="maxAmount"
            type="number"
            min="0"
            step="0.01"
            :required="priceType === 'range'"
            class="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label
            for="price-basis"
            class="block font-medium text-slate-700"
          >
            Price basis
          </label>
          <input
            id="price-basis"
            v-model="priceBasis"
            type="text"
            required
            placeholder="per visit, per hour, per m²…"
            class="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label
            for="price-observed-at"
            class="block font-medium text-slate-700"
          >
            Observed at
          </label>
          <input
            id="price-observed-at"
            v-model="observedAt"
            type="date"
            required
            class="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label
            for="price-notes"
            class="block font-medium text-slate-700"
          >
            Notes
          </label>
          <textarea
            id="price-notes"
            v-model="notes"
            rows="3"
            class="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </div>

        <p
          v-if="errorMessage"
          class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          role="alert"
        >
          {{ errorMessage }}
        </p>
        <button
            v-if="
                errorMessage ===
                'This price was changed by someone else. Reload and try again.'
            "
            type="button"
            class="text-sm font-medium text-blue-700 underline"
            @click="emit('reloadRequested')"
        >
            Reload prices
        </button>


        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700"
            :disabled="isSubmitting"
            @click="close"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            :disabled="isSubmitting"
          >
            {{ isSubmitting ? 'Saving…' : submitLabel }}
          </button>
        </div>
      </form>
    </section>
  </div>
</template>