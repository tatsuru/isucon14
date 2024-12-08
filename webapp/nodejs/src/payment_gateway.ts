import { ulid } from "ulid";
import { ErroredUpstream } from "./common.js";
import type { Ride } from "./types/models.js";
import { setTimeout } from "node:timers/promises";

type PaymentGatewayPostPaymentRequest = {
  amount: number;
};

export const requestPaymentGatewayPostPayment = async (
  paymentGatewayURL: string,
  token: string,
  param: PaymentGatewayPostPaymentRequest,
  retrieveRidesOrderByCreatedAtAsc: () => Promise<Ride[]>
): Promise<ErroredUpstream | Error | undefined> => {
  const idempotencyKey = ulid();

  let retry = 0;
  while (true) {
    try {
      const res = await fetch(`${paymentGatewayURL}/payments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(param),
      });

      if (res.status !== 204) {
        // エラーが返ってきても成功している場合があるので、社内決済マイクロサービスに問い合わせ
        const getRes = await fetch(`${paymentGatewayURL}/payments`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Idempotency-Key": idempotencyKey,
          },
        });

        // GET /payments は障害と関係なく200が返るので、200以外は回復不能なエラーとする
        if (getRes.status !== 200) {
          return new Error(
            `[GET /payments] unexpected status code (${getRes.status})`
          );
        }
        const payments = await getRes.json();

        const rides = await retrieveRidesOrderByCreatedAtAsc();
        if (rides.length !== payments.length) {
          throw new ErroredUpstream(
            `unexpected number of payments: ${rides.length} != ${payments.length}`
          );
        }
      }
      break;
    } catch (err) {
      if (retry < 5) {
        retry++;
        // Exponential backoff
        await setTimeout(2 ** retry * 100);
      } else {
        throw err;
      }
    }
  }
};
