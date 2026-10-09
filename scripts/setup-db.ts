import { resetDemo } from "../lib/demo";
import { pool } from "../lib/db";
resetDemo().then((r) => { console.log("seeded", r); return pool.end(); });
