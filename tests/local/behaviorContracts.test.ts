import { describe, expect, it } from "vitest";
import { extractBehaviorContracts } from "../../src/local/analyze/behaviorContracts.js";

describe("behavior contract extraction", () => {
  it("extracts Nest controller method contracts", () => {
    const contracts = extractBehaviorContracts(`
      import { Controller, Get, Post } from "@nestjs/common";

      @Controller("owners")
      export class OwnerController {
        @Get(":id")
        /**
         * Real Nest code commonly places docs between decorator and method.
         */
        async findOne() {}

        @Post()
        create() {}
      }
    `, "src/owners/owner.controller.ts");

    expect(contracts).toEqual([
      expect.objectContaining({
        kind: "http_endpoint",
        framework: "nestjs",
        method: "GET",
        path: "/owners/:id",
        handler: "findOne",
        controller: "OwnerController",
        title: "GET /owners/:id"
      }),
      expect.objectContaining({
        framework: "nestjs",
        method: "POST",
        path: "/owners",
        handler: "create",
        controller: "OwnerController",
        title: "POST /owners"
      })
    ]);
  });

  it("extracts Express and Fastify router contracts", () => {
    const contracts = extractBehaviorContracts(`
      router.get("/health", healthCheck);
      app.post("/orders", handlers.createOrder);
      router.route("/owners").get(owners.findOne).post(owners.create);
      fastify.patch("/orders/:id", { schema }, async (request, reply) => {});
    `, "src/routes/orders.ts");

    expect(contracts).toEqual([
      expect.objectContaining({
        framework: "express",
        method: "GET",
        path: "/health",
        handler: "healthCheck"
      }),
      expect.objectContaining({
        framework: "express",
        method: "POST",
        path: "/orders",
        handler: "handlers.createOrder"
      }),
      expect.objectContaining({
        framework: "express",
        method: "GET",
        path: "/owners",
        handler: "owners.findOne"
      }),
      expect.objectContaining({
        framework: "express",
        method: "POST",
        path: "/owners",
        handler: "owners.create"
      }),
      expect.objectContaining({
        framework: "fastify",
        method: "PATCH",
        path: "/orders/:id",
        handler: undefined
      })
    ]);
  });

  it("extracts file-route HTTP exports used by Medusa/Next-style APIs", () => {
    const contracts = extractBehaviorContracts(`
      export async function POST(req: Request) { return Response.json({ ok: true }); }
      export const GET = async () => Response.json([]);
    `, "packages/medusa/src/api/store/carts/[id]/complete/route.ts");

    expect(contracts).toEqual([
      expect.objectContaining({
        framework: "file_route",
        method: "POST",
        path: "/store/carts/:id/complete",
        handler: "POST",
        title: "POST /store/carts/:id/complete"
      }),
      expect.objectContaining({
        framework: "file_route",
        method: "GET",
        path: "/store/carts/:id/complete",
        handler: "GET",
        title: "GET /store/carts/:id/complete"
      })
    ]);
  });
});
