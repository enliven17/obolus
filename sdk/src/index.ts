export { ObolusClient } from './client';
export type {
  OrderOptions,
  OrderResponse,
  OrderStatus,
  OrderListItem,
  OrderPhase,
  CardDetails,
  PaymentInstructions,
  Budget,
  UsageSummary,
} from './client';

export {
  createWallet,
  getBalance,
  addUsdcToken Account,
  payViaContract,
  purchaseCard,
  // Back-compat alias for payViaContract.
  payVCC,
} from './solana';
export type { WalletInfo, PayOpts } from './solana';

export {
  createOWSWallet,
  getOWSPublicKey,
  getOWSBalance,
  addUsdcToken AccountOWS,
  checkSolanaTxLanded,
  payViaContractOWS,
  purchaseCardOWS,
  onboardAgent,
  // Back-compat alias.
  payVCCOWS,
} from './ows';
export type {
  Token AccountOpts,
  PayViaContractOwsOpts,
  PayVCCOwsOpts,
  PurchaseCardOwsOpts,
  OnboardAgentOpts,
  OnboardAgentResult,
} from './ows';

export {
  ObolusError,
  SpendLimitError,
  RateLimitError,
  ServiceUnavailableError,
  PriceUnavailableError,
  InvalidAmountError,
  AuthError,
  OrderFailedError,
  WaitTimeoutError,
  ResumableError,
} from './errors';

export { InsufficientFeeError } from './solana';

export { mppCharge } from './mpp';
export type { MppChargeOpts, MppChargeResult } from './mpp';

export { loadObolusConfig, saveObolusConfig, resolveCredentials } from './config';
export type { ObolusConfig } from './config';
