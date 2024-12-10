import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { RowDataPacket } from "mysql2/promise";
import type { Environment } from "./types/hono.js";
import type { Chair, Owner, User } from "./types/models.js";

const usersCache: { [key: string]: string } = {};

export const appAuthMiddleware = createMiddleware<Environment>(
  async (ctx, next) => {
    const accessToken = getCookie(ctx, "app_session");
    if (!accessToken) {
      return ctx.text("app_session cookie is required", 401);
    }
    try {
      if (usersCache[accessToken]) {
        ctx.set("userID", usersCache[accessToken]);
        return await next();
      }
      const [[user]] = await ctx.var.dbConn.query<Array<User & RowDataPacket>>(
        "SELECT * FROM users WHERE access_token = ?",
        [accessToken]
      );
      if (!user) {
        return ctx.text("invalid access token", 401);
      }
      ctx.set("userID", user.id);
      usersCache[accessToken] = user.id;
    } catch (error) {
      return ctx.text(`Internal Server Error\n${error}`, 500);
    }
    await next();
  }
);

const ownersCache: { [key: string]: string } = {};

export const ownerAuthMiddleware = createMiddleware<Environment>(
  async (ctx, next) => {
    const accessToken = getCookie(ctx, "owner_session");
    if (!accessToken) {
      return ctx.text("owner_session cookie is required", 401);
    }
    try {
      if (ownersCache[accessToken]) {
        ctx.set("ownerID", ownersCache[accessToken]);
        return await next();
      }
      const [[owner]] = await ctx.var.dbConn.query<
        Array<Owner & RowDataPacket>
      >("SELECT * FROM owners WHERE access_token = ?", [accessToken]);
      if (!owner) {
        return ctx.text("invalid access token", 401);
      }
      ctx.set("ownerID", owner.id);
      ownersCache[accessToken] = owner.id;
    } catch (error) {
      return ctx.text(`Internal Server Error\n${error}`, 500);
    }
    await next();
  }
);

const chairsCache: { [key: string]: string } = {};

export const chairAuthMiddleware = createMiddleware<Environment>(
  async (ctx, next) => {
    const accessToken = getCookie(ctx, "chair_session");
    if (!accessToken) {
      return ctx.text("chair_session cookie is required", 401);
    }
    try {
      if (chairsCache[accessToken]) {
        ctx.set("chairID", chairsCache[accessToken]);
        return await next();
      }
      const [[chair]] = await ctx.var.dbConn.query<
        Array<Chair & RowDataPacket>
      >("SELECT * FROM chairs WHERE access_token = ?", [accessToken]);
      if (!chair) {
        return ctx.text("invalid access token", 401);
      }
      ctx.set("chairID", chair.id);
      chairsCache[accessToken] = chair.id;
    } catch (error) {
      return ctx.text(`Internal Server Error\n${error}`, 500);
    }
    await next();
  }
);
