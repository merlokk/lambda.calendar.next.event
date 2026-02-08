import { handler } from "./index.mjs";

// имитируем вызов Lambda
const fakeEvent = {
  httpMethod: "GET",
  headers: {},
  queryStringParameters: null,
};

async function main() {
  try {
    const res = await handler(fakeEvent);
    console.log("=== LAMBDA RESPONSE ===");
    console.log(JSON.stringify(res, null, 2));
    if (typeof res?.body !== 'undefined' && res?.body !== null) {
      console.log("--- body ---");
      console.log(JSON.stringify(JSON.parse(res.body),null, 2));
    }
  } catch (e) {
    console.error("ERROR:", e);
  }
}

main();
