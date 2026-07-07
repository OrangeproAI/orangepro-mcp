// A clean, extensionless re-export barrel (bundler resolution). getAliasedSymbol
// + walkBarrel must follow `@app/barrel` -> ./orders -> placeOrder terminal.
export { placeOrder } from "./orders";
export type { Order } from "./orders";
