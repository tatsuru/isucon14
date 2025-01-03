import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import {
  appGetNearbyChairs,
  appGetNotification,
  appGetRides,
  appPostPaymentMethods,
  appPostRideEvaluatation,
  appPostRides,
  appPostRidesEstimatedFare,
  appPostUsers,
} from "./app_handlers.js";
import {
  chairGetNotification,
  chairPostActivity,
  chairPostChairs,
  chairPostCoordinate,
  chairPostRideStatus,
} from "./chair_handlers.js";
import {
  appAuthMiddleware,
  chairAuthMiddleware,
  ownerAuthMiddleware,
} from "./middlewares.js";
import {
  ownerGetChairs,
  ownerGetSales,
  ownerPostOwners,
} from "./owner_handlers.js";
import type { Environment } from "./types/hono.js";
import { execSync } from "node:child_process";
import { internalGetMatching } from "./internal_handlers.js";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { logger } from "hono/logger";

const pool = createPool({
  host: process.env.ISUCON_DB_HOST || "127.0.0.1",
  port: Number(process.env.ISUCON_DB_PORT || "3306"),
  user: process.env.ISUCON_DB_USER || "isucon",
  password: process.env.ISUCON_DB_PASSWORD || "isucon",
  database: process.env.ISUCON_DB_NAME || "isuride",
  timezone: "+00:00",
});

const app = new Hono<Environment>();
//app.use(logger());
app.use(
  createMiddleware<Environment>(async (ctx, next) => {
    const connection = await pool.getConnection();
    ctx.set("dbConn", connection);
    try {
      await next();
    } finally {
      await connection.rollback();
      pool.releaseConnection(connection);
    }
  })
);

app.post("/api/initialize", postInitialize);

// app handlers
app.post("/api/app/users", appPostUsers);

app.post("/api/app/payment-methods", appAuthMiddleware, appPostPaymentMethods);
app.get("/api/app/rides", appAuthMiddleware, appGetRides);
app.post("/api/app/rides", appAuthMiddleware, appPostRides);
app.post(
  "/api/app/rides/estimated-fare",
  appAuthMiddleware,
  appPostRidesEstimatedFare
);
app.post(
  "/api/app/rides/:ride_id/evaluation",
  appAuthMiddleware,
  appPostRideEvaluatation
);
app.get("/api/app/notification", appAuthMiddleware, appGetNotification);
app.get("/api/app/nearby-chairs", appAuthMiddleware, appGetNearbyChairs);

// owner handlers
app.post("/api/owner/owners", ownerPostOwners);

app.get("/api/owner/sales", ownerAuthMiddleware, ownerGetSales);
app.get("/api/owner/chairs", ownerAuthMiddleware, ownerGetChairs);

// chair handlers
app.post("/api/chair/chairs", chairPostChairs);

app.post("/api/chair/activity", chairAuthMiddleware, chairPostActivity);
app.post("/api/chair/coordinate", chairAuthMiddleware, chairPostCoordinate);
app.get("/api/chair/notification", chairAuthMiddleware, chairGetNotification);
app.post(
  "/api/chair/rides/:ride_id/status",
  chairAuthMiddleware,
  chairPostRideStatus
);

// internal handlers
app.get("/api/internal/matching", internalGetMatching);

const port = 8080;
serve(
  {
    fetch: app.fetch,
    port,
  },
  (addr) => {
    console.log(`Server is running on http://localhost:${addr.port}`);
  }
);

async function postInitialize(ctx: Context<Environment>) {
  const body = await ctx.req.json<{ payment_server: string }>();
  try {
    execSync("../sql/init.sh", { stdio: "inherit" });
  } catch (error) {
    return ctx.text(`Failed to initialize\n${error}`, 500);
  }
  try {
    await ctx.var.dbConn.query(
      "UPDATE settings SET value = ? WHERE name = 'payment_gateway_url'",
      [body.payment_server]
    );

    const [rows] = await ctx.var.dbConn.query<
      Array<
        {
          id: string;
          total_distance: number;
          total_distance_updated_at: Date;
        } & RowDataPacket
      >
    >(
      `SELECT id,
      IFNULL(total_distance, 0) AS total_distance,
      total_distance_updated_at
      FROM chairs
      LEFT JOIN (SELECT chair_id,
              SUM(IFNULL(distance, 0)) AS total_distance,
              MAX(created_at)          AS total_distance_updated_at
           FROM (SELECT chair_id,
                  created_at,
                  ABS(latitude - LAG(latitude) OVER (PARTITION BY chair_id ORDER BY created_at)) +
                  ABS(longitude - LAG(longitude) OVER (PARTITION BY chair_id ORDER BY created_at)) AS distance
               FROM chair_locations) tmp
           GROUP BY chair_id) distance_table ON distance_table.chair_id = chairs.id`
    );

    await ctx.var.dbConn.query(
      "ALTER TABLE chairs ADD COLUMN total_distance BIGINT NOT NULL DEFAULT 0"
    );

    for (const row of rows) {
      if (!row.total_distance_updated_at) {
        continue;
      }
      await ctx.var.dbConn.query(
        `UPDATE chairs SET total_distance = ?, updated_at = ? WHERE id = ?`,
        [row.total_distance, row.total_distance_updated_at, row.id]
      );
    }
  } catch (error) {
    console.error(error);
    return ctx.text(`Internal Server Error\n${error}`, 500);
  }
  return ctx.json({ language: "node" });
}
