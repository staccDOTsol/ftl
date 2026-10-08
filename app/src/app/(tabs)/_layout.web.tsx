import { Slot } from 'expo-router'

// The web workspace owns persistent navigation on every route. Native keeps
// its existing tabs; Slot also avoids background screens fetching unseen data.
export default function WebTabs() { return <Slot /> }
