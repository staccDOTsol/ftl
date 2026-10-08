import { useClock } from './clock'

export function useNow(every = 5000) {
  // Share the app clock instead of creating a timer for every mounted screen.
  return Math.floor(useClock() / every) * every
}
