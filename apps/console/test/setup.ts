import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Unmount React trees between tests so timers/effects (clipboard clears, reveal
// TTLs, window listeners) from one test can't leak into the next.
afterEach(() => {
  cleanup()
})
