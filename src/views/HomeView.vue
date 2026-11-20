<script setup lang="ts">

import MapView from '../components/MapView.vue'
//import { ref } from 'vue'

import LocationDetails from '../components/LocationDetails.vue'
import SearchBox from '../components/SearchBox.vue'
import { onMounted, ref } from 'vue'

type Me = {
  id: string
  email: string | null
  displayName: string | null
  isCurator: boolean
}

const selectedLocationId = ref<number | null>(null)
const me = ref<Me | null>(null)

const handleLocationSelected = (locationId: number) => {
  selectedLocationId.value = locationId
}

const handleSearchLocationSelected = (locationId: number) => {
  selectedLocationId.value = locationId
}

const loadCurrentUser = async () => {
  const response = await fetch('/api/me')

  if (response.status === 401) {
    me.value = null
    return
  }

  if (!response.ok) {
    throw new Error(`Current-user request failed with status ${response.status}`)
  }

  me.value = (await response.json()) as Me
}

const signIn = () => {
  window.location.assign('/api/auth/google')
}

const signOut = async () => {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`Sign-out request failed with status ${response.status}`)
  }

  me.value = null
  window.location.reload()
}

const handleAuthInvalidated = () => {
  me.value = null
}

onMounted(() => {
  void loadCurrentUser().catch(() => {
    me.value = null
  })
})


</script>



<template>
  <main
    class="relative grid h-[100dvh] w-full grid-cols-1 overflow-hidden bg-slate-100 lg:grid-cols-[minmax(0,1fr)_24rem]"
  >
      <header
  class="absolute left-4 top-4 z-20 flex items-center gap-3 rounded-md bg-white/90 px-3 py-2 text-sm text-slate-700 shadow-sm"
>
  <SearchBox @select-location="handleSearchLocationSelected" />

  <button
    v-if="me === null"
    type="button"
    class="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
    @click="signIn"
  >
    Sign in with Google
        </button>

        <template v-else>
          <span class="whitespace-nowrap">
            Signed in as {{ me.displayName || me.email || 'Contributor' }}
          </span>
          <button
            type="button"
            class="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
            @click="signOut"
          >
            Sign out
          </button>
        </template>
      </header>
    <section class="min-h-0 min-w-0">
      <MapView @location-selected="handleLocationSelected" />
    </section>

    <aside class="min-h-0 overflow-y-auto border-t border-slate-200 bg-white lg:border-l lg:border-t-0">
      <LocationDetails
        :selected-location-id="selectedLocationId"
        :me="me"
        @auth-invalidated="handleAuthInvalidated"
      />
    </aside>
  </main>
</template>
