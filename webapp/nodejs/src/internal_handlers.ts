import type { Context } from "hono";
import type { Environment } from "./types/hono.js";
import type { RowDataPacket } from "mysql2";
import type { Chair, ChairLocation, Ride } from "./types/models.js";

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
WHERE is_active = TRUE AND ((rs.status = 'COMPLETED' AND rs.chair_sent_at IS NOT NULL) OR rs.status IS NULL)`
  );

  // 椅子がない場合は何もしない
  if (chairs.length === 0) {
    return ctx.body(null, 204);
  }

  // 空いている椅子の位置情報を取得
  const chairIds = chairs.map((chair) => chair.id);
  const [chairLocations] = await ctx.var.dbConn.query<
    Array<ChairLocation & RowDataPacket>
  >(
    `SELECT cl1.chair_id, cl1.latitude, cl1.longitude
    FROM chair_locations cl1
    INNER JOIN (
      SELECT chair_id, MAX(created_at) AS latest_created_at
      FROM chair_locations
      WHERE chair_id IN (${chairIds.map(() => "?").join(",")})
      GROUP BY chair_id
    ) cl2 ON cl1.chair_id = cl2.chair_id AND cl1.created_at = cl2.latest_created_at`,
    chairIds
  );

  // ライドを取得
  const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
    "SELECT * FROM rides WHERE chair_id IS NULL ORDER BY created_at"
  );

  // ライドと椅子をマッチング
  for (const ride of rides) {
    console.log(`Matching ride ${ride.id}`);
    // 最も近い椅子を探す
    // 0,0 と 300, 300付近にクラスターがあるので、マンハッタン距離200で足切りする
    let minDistance = Infinity;
    let nearestChair: (ChairLocation & RowDataPacket) | null = null;

    console.log(`Remaining chairs: ${chairs.length}`);
    for (const chair of chairLocations) {
      const distance =
        Math.abs(chair.latitude - ride.pickup_latitude) +
        Math.abs(chair.longitude - ride.pickup_longitude);
      console.log(`Chair ${chair.chair_id} distance: ${distance}`);
      if (distance < minDistance) {
        minDistance = distance;
        nearestChair = chair;
      }
    }
    console.log(
      `Nearest chair: ${nearestChair?.chair_id}, distance: ${minDistance}`
    );

    // ライドに椅子を紐付ける
    if (nearestChair) {
      console.log(
        `Matched ride ${ride.id} with chair ${nearestChair.chair_id}`
      );
      await ctx.var.dbConn.query("UPDATE rides SET chair_id = ? WHERE id = ?", [
        nearestChair.chair_id,
        ride.id,
      ]);

      // 紐付けた椅子を消す
      chairLocations.splice(chairLocations.indexOf(nearestChair), 1);
      console.log(`Remaining chairs: ${chairLocations.length}`);

      // 椅子がなくなったら終了
      if (chairLocations.length === 0) {
        break;
      }
    }
  }

  return ctx.body(null, 204);
};
