import { describe, it, expect, beforeAll } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import {
  buildConfirmProgram,
  confirmPair,
  runConfirmer,
  type ConfirmProgram
} from "../../src/local/analyze/confirm.js";
import { resetResolverCaches } from "../../src/local/resolve/resolver.js";
import { resetExportIndexCache } from "../../src/local/resolve/exportIndex.js";
import { SELF_ASSERT_HELPERS } from "../../src/local/analyze/selfAssert.js";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/local/analyze/__fixtures__/confirm");
const at = (f: string): string => resolve(FIX, f);

// Behavior under test per fixture. saveUser@impl.ts for most; LoginForm@LoginForm.tsx for renders.
const IMPL = at("impl.ts");
const LOGIN = at("LoginForm.tsx");
const DEFAULT_IMPL = at("defaultExport.ts");
const APP_SERVICE = at("application.service.ts");

interface Case {
  file: string;
  impl: string;
  behavior: string;
  expect: "confirmed" | "inferred" | "none";
}

const NEGATIVES: Case[] = [
  { file: "N1-unused-import.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N2-mock-only.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N3-type-only.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N4-string-mention.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N5-snapshot-mention.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N6-shallow-defined.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N7-barrel-ambiguous.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N8-fixture-helper.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N9-skipped.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N10-use-no-assert.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N11-renamed-string.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N12-toplevel-unrelated-assert.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N13-use-unrelated-assert.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N14-barrel-mock.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N15-overwritten-bound.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N16-laundered-ambiguous.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N17-fake-render.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N18-bare-expect-no-matcher.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N19-expect-impostor-call.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N20-expect-value-method.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N21-expect-comma-discard.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N22-expect-extra-arg.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N23-expect-towellformed.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N24-local-selfassert-spoof.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N25-local-assert-spoof.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N26-describe-skipif.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N27-assert-message-arg.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N28-expect-tohex.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N29-skipif-bracket.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N30-thunk-noninvoking.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N31-assert-fail-message.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N32-matcher-ignored-arg.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N33-ternary-thunk.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N34-dynamic-import-mock.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N35-skip-each.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N36-test-fails.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N37-foreach-discard.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N38-throw-incidental.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N39-render-after-assert.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "inferred" },
  { file: "N40-multi-render.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "inferred" },
  { file: "N41-bare-jsx-element.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "inferred" },
  { file: "N42-hof-block-side-effect.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N43-nested-jsx-wrapper.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "inferred" },
  { file: "N44-const-render-after-assert.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "inferred" },
  { file: "N45-uninvoked-render-thunk.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "inferred" },
  { file: "N46-uninvoked-const-render-thunk.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "inferred" },
  { file: "N47-local-noop-act.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "inferred" },
  { file: "N48-object-map-callback.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N49-array-from-source-fn.test.ts", impl: IMPL, behavior: "saveUser", expect: "inferred" },
  { file: "N50-mocked-framework.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "inferred" },
  { file: "N51-nest-target-mocked.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "N52-nest-assert-before-call.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "N53-nest-unrelated-expect.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "N54-nest-side-effect-only.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "N90-nest-usevalue-override.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "N91-nest-overrideprovider.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "N92-nest-spyon-stub.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "N93-nest-reassigned-binding.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "N94-nest-useclass-fake.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "N95-nest-other-service-assert.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "N96-nest-mockimpl-prototype.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "N97-nest-construction-toBeDefined.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "V90-nest-instance-prop-stub.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "V91-nest-object-assign-stub.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "V92-nest-aliased-token.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "V100-nest-computed-assign.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "V101-nest-replaceproperty.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "V102-nest-defineproperty.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "V110-nest-reflect-set.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "V111-nest-defineproperty-getter.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "V112-nest-arrow-assign.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "W01-nest-defineproperties-plural.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "W02-nest-reflect-defineproperty.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "W03-nest-setprototypeof.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "W04-nest-helper-indirection.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "W05-nest-aliased-defineproperty.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "W06-nest-variable-keyed-assign.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-reflect-defineproperty-value.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-reflect-defineproperty-get.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-objdescr-defineproperties.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-objdescr-definegetter.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-reflect-getprototypeof-mutate.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-proto-setPrototypeOf.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-proto-getPrototypeOf-assign.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-proto-constructor-prototype.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-proto-dunder-member.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-proto-dunder-swap.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-indirection-helper-fn.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-indirection-alias-objassign.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-indirection-alias-reflectset.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-indirection-foreach-dynamickey.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-indirection-tuple-applier.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-proxy-proto-gettrap.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-spreadclone-proto.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-defineprops-plural.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-reflect-defineproperty.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-getprototypeof-assign.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-di-computed-provide-token.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-di-factory-built-provider.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-di-compound-rebind.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-di-get-then-setproto.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R5-di-override-computed-token.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "X01-alias-then-mutate.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "X02-second-binding-mutate.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "X03-class-mutate-in-beforeEach.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6F-paren-get.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6F-assign-get.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6F-defineprop-get.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6F-destructure-get.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6F-fresh-getproto.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6F-fresh-defineproperty-proto.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6F-fresh-ctor-proto.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6F-fresh-proto-var.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6F-awaitget.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6F-tokenidx.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6F-protohook.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "G1-interproc-2level.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "G2-object-property-stash.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "G3-map-stash.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "G4-array-literal-index.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "G5-alias-via-object-then-id.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7F-relay.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7F-stash.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7F-wrap.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7F-objprop.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7F-mapget.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7F-arridx.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7F-passthru.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7F-aliasgetproto.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7F-helperproto.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7F-helperctor.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "H1-closure-return-getter.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "H2-ternary-init.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "H3-push-then-index.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "H4-map-constructor.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "H5-object-values.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "H6-async-passthrough.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R8F-getter-capture.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R8F-ternary-alias.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R8F-getter-property.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R8F-map-constructor-entry.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R8F-pt-local.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R8F-detach-prop.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R8F-wrap-this.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R8F-closure-ret.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-nested-object-literal.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-array-of-objects-index-prop.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-map-value-container.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-container-restash-alias.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-nested-objprop-reflectset.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-at-accessor-defineproperty.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-spread-array-protoctor.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-mapfromentries-reflectset.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-obj-destructure-rename.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-comma-sequence-receiver.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-forward-order-twofn.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-destructure-assign.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-helper-reflect-container.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-helper-local-alias.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9F-helper-seen-index.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
];

const POSITIVES: Case[] = [
  { file: "P1-call-assert.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P2-render-assert.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "confirmed" },
  { file: "P3-self-assert.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "confirmed" },
  { file: "P4-barrel-followed.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P5-cypress-should.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "confirmed" },
  { file: "P6-findby-render.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "confirmed" },
  { file: "P7-map-nested.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P8-default-export.test.ts", impl: DEFAULT_IMPL, behavior: "makeReport", expect: "confirmed" },
  { file: "P9-node-assert.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P10-expect-matcher-arg.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P11-aliased-screen.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "confirmed" },
  { file: "P12-throw-thunk.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P13-expect-soft.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P14-bracket-assert.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P15-map-inline.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P16-reduce-inline.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P17-as-expression.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P18-it-each.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P19-const-ui-render.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "confirmed" },
  { file: "P20-act-render.test.tsx", impl: LOGIN, behavior: "LoginForm", expect: "confirmed" },
  { file: "P21-promise-then.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P22-array-from-mapfn.test.ts", impl: IMPL, behavior: "saveUser", expect: "confirmed" },
  { file: "P23-nest-testingmodule-service.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "P90-nest-unrelated-spy-real-impl.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "L01-minimal-target-only.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "L02-with-dto-builder.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "L03-setup-call-on-service.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "L04-assert-via-getter.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "L05-service-passed-to-helper.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6L-instguard.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6L-beforeeach.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6L-readonly-helper.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6L-collect-teardown.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6L-warm-read.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6L-resultvar.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6L-resolves.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6L-defined.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6L-instanceof.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R6L-trackcleanup.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "M1-two-real-calls.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "M2-readonly-helper-typeof.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "M3-benign-read-ctor.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7L-loop-inputs.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7L-multi-service.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7L-readonly-helper-call.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7L-beforeeach-module.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7L-expect-assertions.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7L-sibling-spy.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7L-collab-arg.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R7L-reflect-get-read.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "OC1-service-in-config-object.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "OC2-service-in-array.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "OC3-readonly-helper-calls-target.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R8L-ctxbag.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R8L-registry.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R8L-spreadctx.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R8L-casetable.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9L-helper-capture-instance.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9L-provider-builder-call.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9L-helper-tags-field.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9L-helper-reads-into-local.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
  { file: "R9L-scenario-tuple.test.ts", impl: APP_SERVICE, behavior: "ApplicationService.uploadDefaultPackageFilesAndSetFileIds", expect: "inferred" },
];
const HARD_POSITIVES = POSITIVES.filter((c) => c.expect === "confirmed");
const NEST_DI_ASSOCIATED = POSITIVES.filter((c) => c.expect === "inferred");

let ctx: ConfirmProgram;

beforeAll(() => {
  resetResolverCaches();
  resetExportIndexCache();
  // Build one Program over every fixture file (the bounded test+source closure).
  const files = readdirSync(FIX)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map(at);
  ctx = buildConfirmProgram(files, FIX);
});

describe("confirmer — golden negatives never CONFIRM", () => {
  for (const c of NEGATIVES) {
    it(`${c.file} -> ${c.expect} (never confirmed)`, () => {
      const v = confirmPair(ctx, at(c.file), c.impl, c.behavior);
      expect(v.verdict).toBe(c.expect);
      expect(v.verdict).not.toBe("confirmed");
      // A downgraded negative records WHY (the rejected conjunct), so a future
      // regression that promotes it to a hard edge fails loudly.
      expect(v.rejected_conjunct).toBeGreaterThanOrEqual(1);
    });
  }
});

describe("confirmer — golden positives (P1-P6) CONFIRM", () => {
  for (const c of HARD_POSITIVES) {
    it(`${c.file} -> confirmed`, () => {
      const v = confirmPair(ctx, at(c.file), c.impl, c.behavior);
      expect(v.verdict).toBe("confirmed");
    });
  }
});

describe("confirmer — NestJS TestingModule stays associated-only until alias closure is sound", () => {
  for (const c of NEST_DI_ASSOCIATED) {
    it(`${c.file} -> inferred (not Proven)`, () => {
      const v = confirmPair(ctx, at(c.file), c.impl, c.behavior);
      expect(v.verdict).toBe("inferred");
      expect(v.verdict).not.toBe("confirmed");
      expect(v.reason).toContain("NestJS TestingModule DI target proof is associated-only");
    });
  }
});

describe("confirmer — false-confirm safety invariants", () => {
  it("0 of the golden negatives ever resolve to CONFIRMED (the hard-stop gate)", () => {
    const falseConfirmed = NEGATIVES.filter(
      (c) => confirmPair(ctx, at(c.file), c.impl, c.behavior).verdict === "confirmed"
    ).map((c) => c.file);
    expect(falseConfirmed).toEqual([]);
  });

  it("0 NestJS TestingModule cases resolve to CONFIRMED until the alias-closure gate lands", () => {
    const falseConfirmed = NEST_DI_ASSOCIATED.filter(
      (c) => confirmPair(ctx, at(c.file), c.impl, c.behavior).verdict === "confirmed"
    ).map((c) => c.file);
    expect(falseConfirmed).toEqual([]);
  });

  it("a basename/name match alone (helper of the same name) never yields a hard verdict", () => {
    // N8 imports `saveUser` from a helper that shares the name — pure name match.
    const v = confirmPair(ctx, at("N8-fixture-helper.test.ts"), IMPL, "saveUser");
    expect(v.verdict).toBe("inferred");
    expect(v.rejected_conjunct).toBe(1); // binding identity, not name, decides
  });

  it("a behavior the test has nothing to do with resolves to NONE, not a guess", () => {
    // P1 exercises saveUser; it does not touch deleteUser at all.
    const v = confirmPair(ctx, at("P1-call-assert.test.ts"), IMPL, "deleteUser");
    expect(v.verdict).toBe("none");
  });

  it("a test outside the program cannot confirm", () => {
    const v = confirmPair(ctx, at("does-not-exist.test.ts"), IMPL, "saveUser");
    expect(v.verdict).toBe("none");
  });
});

describe("confirmer — COVERS targets the CodeSymbol, with cap downgrade (4.4)", () => {
  const candidate = {
    testRel: "P1-call-assert.test.ts",
    testAbs: at("P1-call-assert.test.ts"),
    implRel: "impl.ts",
    implAbs: IMPL
  };
  const symbolsByImpl = new Map([["impl.ts", ["saveUser", "deleteUser"]]]);

  it("emits exactly one COVERS to sym:impl.ts#saveUser when the symbol exists", () => {
    const out = runConfirmer({
      candidates: [candidate],
      symbolsByImpl,
      existingSymIds: new Set(["sym:impl.ts#saveUser", "sym:impl.ts#deleteUser"]),
      anchorFile: FIX
    });
    expect(out.confirmations).toHaveLength(1);
    expect(out.confirmations[0].symId).toBe("sym:impl.ts#saveUser");
    expect(out.confirmations[0].behaviorName).toBe("saveUser");
    expect(out.capped_downgrades).toBe(0);
  });

  it("downgrades to INFERRED (no COVERS) when the confirmed symbol was capped out", () => {
    const out = runConfirmer({
      candidates: [candidate],
      symbolsByImpl,
      existingSymIds: new Set([]), // saveUser capped out of the graph
      anchorFile: FIX
    });
    expect(out.confirmations).toHaveLength(0);
    expect(out.capped_downgrades).toBe(1); // never COVERS-to-file
  });
});

describe("self-assert allow-list (4.3) — every entry has a committed fixture", () => {
  it("each SELF_ASSERT_HELPERS entry names a fixture that exists on disk", () => {
    for (const h of SELF_ASSERT_HELPERS) {
      expect(existsSync(at(h.fixture)), `${h.id} -> ${h.fixture}`).toBe(true);
    }
  });
});
