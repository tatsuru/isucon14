import type { Context } from "hono";
import type { Environment } from "./types/hono.js";
import type { RowDataPacket } from "mysql2";
import type { Chair, Ride } from "./types/models.js";

// このAPIをインスタンス内から一定間隔で叩かせることで、椅子とライドをマッチングさせる
export const internalGetMatching = async (ctx: Context<Environment>) => {
  // 空いている椅子を取得
  const [chairs] = await ctx.var.dbConn.query<Array<Chair & RowDataPacket>>(
    `SELECT chairs.*
FROM chairs
LEFT JOIN (
    SELECT 
        ride_id,
        MAX(created_at) AS latest_status_time
    FROM ride_statuses
    GROUP BY ride_id
) latest_status ON chairs.id = latest_status.ride_id
LEFT JOIN ride_statuses rs ON latest_status.ride_id = rs.ride_id AND latest_status.latest_status_time = rs.created_at
WHERE is_active = TRUE AND (rs.status = 'COMPLETED' OR rs.status IS NULL)`
  );

  // 椅子がない場合は何もしない
  if (chairs.length === 0) {
    return ctx.body(null, 204);
  }

  // ライドを取得
  const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
    "SELECT * FROM rides WHERE chair_id IS NULL ORDER BY created_at"
  );

  // ライドと椅子をマッチング
  for (const ride of rides) {
    // 最も近い椅子を探す
    // 0,0 と 300, 300付近にクラスターがあるので、マンハッタン距離200で足切りする
    let minDistance = Infinity;
    let nearestChair: (Chair & RowDataPacket) | null = null;

    for (const chair of chairs) {
      const distance =
        Math.abs(chair.latitude - ride.pickup_latitude) +
        Math.abs(chair.longitude - ride.pickup_longitude);
      if (distance < minDistance) {
        minDistance = distance;
        nearestChair = chair;
      }
    }

    // ライドに椅子を紐付ける
    if (nearestChair) {
      await ctx.var.dbConn.query("UPDATE rides SET chair_id = ? WHERE id = ?", [
        nearestChair.id,
        ride.id,
      ]);

      // 紐付けた椅子を消す
      chairs.splice(chairs.indexOf(nearestChair), 1);

      // 椅子がなくなったら終了
      if (chairs.length === 0) {
        break;
      }
    }
  }

  return ctx.body(null, 204);
};
