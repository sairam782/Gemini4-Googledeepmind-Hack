import { NativeModule, requireOptionalNativeModule } from 'expo';

import type { ScreeningDecision } from './CallScreener.types';

declare class CallScreenerModule extends NativeModule<{}> {
  isSupported(): boolean;
  isScreeningRoleHeld(): boolean;
  requestScreeningRole(): Promise<boolean>;
  setScreeningEnabled(enabled: boolean): void;
  isScreeningEnabled(): boolean;
  getLastDecision(): ScreeningDecision | null;
}

// Android-only module. On iOS (and in Expo Go) this is null, so callers must check.
export default requireOptionalNativeModule<CallScreenerModule>('CallScreener');
