import { Platform } from 'react-native'

// React Native Web supports dataSet; native's prop types intentionally omit it.
// Keeping this in a spread also keeps DOM-only attributes off native views.
export const webData = (dataSet: Record<string, string | number | boolean>) => Platform.OS === 'web' ? { dataSet } : {}
