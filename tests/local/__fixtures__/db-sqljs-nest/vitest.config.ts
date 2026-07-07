import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Nest DI and TypeORM decorators need design-type metadata, which esbuild (vitest's
// default TS transform) does not emit. SWC with decoratorMetadata restores it so the
// generated sqljs spec can boot a real Nest module. This is the runner/config path the
// db-sqljs recipe's setup profile points at.
export default defineConfig({
  test: {
    include: ["orangepro_generated/**/*.spec.ts"],
    environment: "node",
    globals: false
  },
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: "es2021"
      }
    })
  ]
});
