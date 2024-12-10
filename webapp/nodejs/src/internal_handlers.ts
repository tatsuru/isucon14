import type { Context } from "hono";
import type { Environment } from "./types/hono.js";
import type { RowDataPacket } from "mysql2";
import type { Chair, ChairLocation, Ride } from "./types/models.js";

// このAPIをインスタンス内から一定間隔で叩かせることで、椅子とライドをマッチングさせる
export const internalGetMatching = async (ctx: Context<Environment>) => {
  await ctx.var.dbConn.beginTransaction();
  try {
    // ライドを取得
    const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE chair_id IS NULL ORDER BY created_at ASC FOR UPDATE"
    );

    // 空いている椅子を取得
    const [chairs] = await ctx.var.dbConn.query<Array<Chair & RowDataPacket>>(
      `SELECT * FROM chairs WHERE is_active = 1 AND completed = 1 FOR UPDATE`
    );

    // ライドと椅子をマッチング
    for (const ride of rides) {
      console.log(`Matching ride ${ride.id}`);

      // 最も近い椅子を探す
      // 0,0 と 300, 300付近にクラスターがあるので、マンハッタン距離200で足切りする
      let minDistance = 200;
      let nearestChair: (Chair & RowDataPacket) | null = null;

      //console.log(`Remaining chairs: ${chairs.length}`);
      for (const chair of chairs) {
        if (!chair.latitude || !chair.longitude) {
          continue;
        }
        const distance =
          Math.abs(chair.latitude - ride.pickup_latitude) +
          Math.abs(chair.longitude - ride.pickup_longitude);

        console.log(`Chair ${chair.id} distance: ${distance}`);

        if (distance < minDistance) {
          minDistance = distance;
          nearestChair = chair;
        }
      }
      console.log(
        `Nearest chair: ${nearestChair?.id}, distance: ${minDistance}`
      );

      // ライドに椅子を紐付ける
      if (nearestChair) {
        console.log(`Matched ride ${ride.id} with chair ${nearestChair.id}`);
        await ctx.var.dbConn.query(
          "UPDATE rides SET chair_id = ? WHERE id = ?",
          [nearestChair.id, ride.id]
        );

        await ctx.var.dbConn.query(
          "UPDATE chairs SET completed = 0 WHERE id = ?",
          [nearestChair.id]
        );

        // 紐付けた椅子を消す
        chairs.splice(chairs.indexOf(nearestChair), 1);
        //console.log(`Remaining chairs: ${chairLocations.length}`);

        // 椅子がなくなったら終了
        if (chairs.length === 0) {
          break;
        }
      }
    }
    ctx.var.dbConn.commit();
    return ctx.body(null, 204);
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};
