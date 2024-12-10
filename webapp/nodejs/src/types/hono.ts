import type { PoolConnection } from "mysql2/promise";
import type { Chair, Owner, User } from "./models.js";

export type Environment = {
  Variables: {
    dbConn: PoolConnection;
    userID: string;
    ownerID: string;
    chairID: string;
  };
};
