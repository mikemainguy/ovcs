import { ref } from 'vue'
import type { UserInfo } from '@/types/api'

const user = ref<UserInfo | null>(null)
const loaded = ref(false)

export function useUser() {
  async function fetchUser() {
    try {
      const resp = await fetch('/me')
      user.value = await resp.json()
    } catch (err) {
      console.warn('Could not fetch user:', err)
    } finally {
      loaded.value = true
    }
  }

  if (!loaded.value) fetchUser()

  return { user, loaded, fetchUser }
}
