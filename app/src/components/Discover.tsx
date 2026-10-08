import LiveScreen from '@/app/(tabs)/index'
import Signals from '@/app/(tabs)/signals'

// Keep platform-neutral imports in route variants: Metro builds the whole
// route context on native, even though the web variant is never selected.
export default function Discover({ signals = false }: { signals?: boolean }) {
  return signals ? <Signals /> : <LiveScreen />
}
