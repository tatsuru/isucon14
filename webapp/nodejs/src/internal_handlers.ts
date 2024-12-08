import type { Context } from "hono";
import type { Environment } from "./types/hono.js";
import type { RowDataPacket } from "mysql2";
import type { Chair, ChairLocation, Ride } from "./types/models.js";

// このAPIをインスタンス内から一定間隔で叩かせることで、椅子とライドをマッチングさせる
export const internalGetMatching = async (ctx: Context<Environment>) => {
  await ctx.var.dbConn.beginTransaction();
  try {
    // 椅子の速さを取得
    const [chair_models] = await ctx.var.dbConn.query<
      Array<{ id: string; speed: number } & RowDataPacket>
    >(`SELECT name, speed FROM chair_models`);
    const chairModelSpeedMap = new Map<string, number>();
    for (const chair_model of chair_models) {
      chairModelSpeedMap.set(chair_model.id, chair_model.speed);
    }

    // ライドを取得
    const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE chair_id IS NULL ORDER BY created_at ASC FOR UPDATE"
    );

    // 空いている椅子を取得
    const [chairs] = await ctx.var.dbConn.query<Array<Chair & RowDataPacket>>(
      `SELECT * FROM chairs WHERE is_active = 1`
    );

    let completedChairs: Array<Chair & RowDataPacket> = [];

    for (const chair of chairs) {
      const [[result]] = await ctx.var.dbConn.query<
        Array<{ "COUNT(*) = 0": number } & RowDataPacket>
      >(
        `SELECT COUNT(*) = 0 FROM (SELECT COUNT(chair_sent_at) = 6 AS completed FROM ride_statuses WHERE ride_id IN (SELECT id FROM rides WHERE chair_id = ?) GROUP BY ride_id) is_completed WHERE completed = FALSE`,
        [chair.id]
      );

      //console.log(`Chair ${chair.id} completed: ${!!result["COUNT(*) = 0"]}`);

      if (!!result["COUNT(*) = 0"]) {
        completedChairs.push(chair);
      }
    }

    // 椅子がない場合は何もしない
    if (completedChairs.length === 0) {
      return ctx.body(null, 204);
    }

    // 空いている椅子の位置情報を取得
    const chairIds2 = completedChairs.map((chair) => chair.id);
    const [chairLocations] = await ctx.var.dbConn.query<
      Array<ChairLocation & RowDataPacket>
    >(
      `SELECT cl1.chair_id, cl1.latitude, cl1.longitude
        FROM chair_locations cl1
        INNER JOIN (
          SELECT chair_id, MAX(created_at) AS latest_created_at
          FROM chair_locations
          WHERE chair_id IN (${chairIds2.map(() => "?").join(",")})
          GROUP BY chair_id
        ) cl2 ON cl1.chair_id = cl2.chair_id AND cl1.created_at = cl2.latest_created_at`,
      chairIds2
    );
    //console.log(`Chair locations: ${chairLocations.length}`);
    const chairLocationsWithModel = chairLocations.map((cl) => {
      const chair = completedChairs.find((c) => c.id === cl.chair_id)!;
      return { ...cl, model: chair.model };
    });

    // ライドと椅子をマッチング
    for (const ride of rides) {
      // 最も近い椅子を探す
      let minTime = Infinity;
      let nearestChair:
        | (ChairLocation &
            RowDataPacket & {
              model: string;
            })
        | null = null;

      for (const chair of chairLocationsWithModel) {
        const placementDistance =
          Math.abs(chair.latitude - ride.pickup_latitude) +
          Math.abs(chair.longitude - ride.pickup_longitude);
        if (placementDistance > 200) {
          // 0,0 と 300, 300付近にクラスター(都市)があるので、都市をまたぐような配車はしない
          continue;
        }
        const rideDistance =
          Math.abs(ride.pickup_latitude - ride.destination_latitude) +
          Math.abs(ride.pickup_longitude - ride.destination_longitude);

        const time =
          (placementDistance + rideDistance) /
          chairModelSpeedMap.get(chair.model)!;
        //console.log(`Chair ${chair.chair_id} distance: ${distance}`);

        if (time < minTime) {
          minTime = time;
          nearestChair = chair;
        }
      }

      // ライドに椅子を紐付ける
      if (nearestChair) {
        //console.log(
        //  `Matched ride ${ride.id} with chair ${nearestChair.chair_id}`
        //);
        await ctx.var.dbConn.query(
          "UPDATE rides SET chair_id = ? WHERE id = ?",
          [nearestChair.chair_id, ride.id]
        );

        // 紐付けた椅子を消す
        chairLocationsWithModel.splice(
          chairLocationsWithModel.indexOf(nearestChair),
          1
        );
        //console.log(`Remaining chairs: ${chairLocations.length}`);

        // 椅子がなくなったら終了
        if (chairLocationsWithModel.length === 0) {
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
