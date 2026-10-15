import { Hono, type Context } from "hono";
import { z } from "zod";
import { initDB, query, get, run } from "./db";

type WorkersAI = {
  run: (model: string, input: unknown) => Promise<unknown>;
};

type Env = { Bindings: { DB: D1Database; AI?: WorkersAI; AI_COMPANY_NAME?: string } };

const app = new Hono<Env>();

app.use("*", async (c, next) => {
  initDB(c.env);
  await ensureSeeded();
  await next();
});

// ── First-run data ─────────────────────────────────────────────────
// A deploy applies `schema.sql` as DDL only — a seed INSERT there fails the
// whole build — so the defaults and the sample portfolio are written here,
// once, when their tables are still empty. A re-deploy never resurrects a
// row the user deleted, because the table is no longer empty.

const DEFAULT_SETTINGS: Record<string, string> = {
  default_rent_due_day: "1",
  late_fee_amount: "50",
  late_fee_grace_days: "5",
  currency: "USD",
};

const ACTIVE_WORK_ORDER_STATUSES = ["open", "assigned", "in_progress", "pending_owner_decision"] as const;
const TIMELINE_TYPES = ["note", "email", "system_activity"] as const;
const PAYMENT_SOURCES = ["Rental Income Deduction", "Owner Contribution"] as const;

const DEMO_PROPERTIES: Array<[string, string, string, string, string, string, string]> = [
  ["Oakwood Estate", "single_family", "210 Oakwood Ln", "Austin", "TX", "78704", "emerald"],
  ["Honeybee Hideaway", "single_family", "88 Bramble Ct", "Austin", "TX", "78704", "amber"],
  ["308 Mission Apartments", "multi_family", "308 Mission St", "Austin", "TX", "78702", "sky"],
];

/** property index (into DEMO_PROPERTIES), name, beds, baths, sqft, rent, status */
const DEMO_UNITS: Array<[number, string, number, number, number, number, string]> = [
  [0, "Main house", 3, 2, 1450, 2300, "occupied"],
  [1, "Main house", 2, 1, 980, 1700, "occupied"],
  [2, "Unit 1", 1, 1, 620, 1450, "occupied"],
  [2, "Unit 2", 1, 1, 620, 1450, "vacant"],
  [2, "Unit 3", 2, 1, 850, 1850, "occupied"],
];

const DEMO_VENDORS: Array<[string, string, string, string]> = [
  ["Emerald Pool Service", "general", "512-555-0144", "emerald"],
  ["Hill Country Plumbing", "plumber", "512-555-0188", "sky"],
  ["Bright Spark Electric", "electrician", "512-555-0102", "amber"],
];

let seeded = false; // per-isolate fast path; the COUNT re-checks are cheap

async function ensureSeeded(): Promise<void> {
  if (seeded) return;
  seeded = true;
  try {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [key, value]);
    }

    const props = await get<{ n: number }>("SELECT COUNT(*) AS n FROM properties");
    if ((props?.n ?? 0) === 0) {
      const ids: number[] = [];
      for (const p of DEMO_PROPERTIES) {
        await run(
          "INSERT INTO properties (name, type, address, city, state, zip, color) VALUES (?, ?, ?, ?, ?, ?, ?)",
          p,
        );
        const row = await get<{ id: number }>("SELECT id FROM properties ORDER BY id DESC LIMIT 1");
        ids.push(row?.id ?? 0);
      }
      const units = await get<{ n: number }>("SELECT COUNT(*) AS n FROM units");
      if ((units?.n ?? 0) === 0) {
        for (const [pi, name, beds, baths, sqft, rent, status] of DEMO_UNITS) {
          if (!ids[pi]) continue;
          await run(
            "INSERT INTO units (property_id, name, bedrooms, bathrooms, sqft, market_rent, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [ids[pi], name, beds, baths, sqft, rent, status],
          );
        }
      }
    }

    const vendors = await get<{ n: number }>("SELECT COUNT(*) AS n FROM vendors");
    if ((vendors?.n ?? 0) === 0) {
      for (const v of DEMO_VENDORS) {
        await run("INSERT INTO vendors (name, category, phone, color) VALUES (?, ?, ?, ?)", v);
      }
    }
  } catch {
    // A cold database mid-migration, or a table this build has not created
    // yet: the next request retries. Never fail a request over sample data.
    seeded = false;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

const intParam = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};

async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { ok: true, data: parsed.data };
}

function buildUpdate(fields: Record<string, unknown>): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
  }

  const isoNow = () => new Date().toISOString();

  const parseDateToMs = (value: string | null | undefined): number => {
    if (!value) return Date.now();
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  };

  function extractJsonObject(raw: string): string | null {
    const start = raw.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
    return null;
  }
  return { sets, params };
}

// ── Properties ─────────────────────────────────────────────────────

const PropertyInput = z.object({
  name: z.string().min(1),
  type: z.enum(["single_family", "multi_family", "condo", "townhouse", "commercial"]).optional(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  zip: z.string().optional().nullable(),
  year_built: z.number().int().optional().nullable(),
  notes: z.string().optional().nullable(),
  color: z.string().optional(),
});

app.get("/api/properties", async (c) => {
  const rows = await query(
    `SELECT p.*,
       (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id) as unit_count,
       (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id AND u.status = 'occupied') as occupied_count
     FROM properties p ORDER BY p.name`,
  );
  return c.json({ properties: rows });
});

app.get("/api/properties/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const row = await get("SELECT * FROM properties WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ property: row });
});

app.post("/api/properties", async (c) => {
  const parsed = await parseJson(c, PropertyInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO properties (name, type, address, city, state, zip, year_built, notes, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.name, d.type ?? "single_family", d.address ?? null, d.city ?? null, d.state ?? null, d.zip ?? null, d.year_built ?? null, d.notes ?? null, d.color ?? "sky"],
  );
  const row = await get("SELECT * FROM properties WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ property: row }, 201);
});

app.put("/api/properties/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, PropertyInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE properties SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM properties WHERE id = ?", [id]);
  return c.json({ property: row });
});

app.delete("/api/properties/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM properties WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Units ──────────────────────────────────────────────────────────

const UnitInput = z.object({
  property_id: z.number().int(),
  name: z.string().min(1),
  bedrooms: z.number().min(0).optional(),
  bathrooms: z.number().min(0).optional(),
  sqft: z.number().int().optional().nullable(),
  market_rent: z.number().min(0).optional(),
  status: z.enum(["vacant", "occupied", "turnover", "unavailable"]).optional(),
  notes: z.string().optional().nullable(),
});

const UNIT_SELECT = `
  SELECT u.*,
    p.name as property_name,
    p.color as property_color,
    p.address as property_address,
    p.city as property_city,
    (SELECT l.id FROM leases l WHERE l.unit_id = u.id AND l.status = 'active' ORDER BY l.start_date DESC LIMIT 1) as active_lease_id,
    (SELECT t.first_name || ' ' || t.last_name FROM leases l LEFT JOIN tenants t ON t.id = l.primary_tenant_id WHERE l.unit_id = u.id AND l.status = 'active' ORDER BY l.start_date DESC LIMIT 1) as active_tenant_name
  FROM units u
  LEFT JOIN properties p ON p.id = u.property_id
`;

app.get("/api/units", async (c) => {
  const propertyId = intParam(c.req.query("property_id"));
  const status = c.req.query("status");
  const where: string[] = [];
  const params: unknown[] = [];
  if (propertyId) { where.push("u.property_id = ?"); params.push(propertyId); }
  if (status) { where.push("u.status = ?"); params.push(status); }
  const sql = `${UNIT_SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY p.name, u.name`;
  const rows = await query(sql, params);
  return c.json({ units: rows });
});

app.get("/api/units/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const row = await get(`${UNIT_SELECT} WHERE u.id = ?`, [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ unit: row });
});

app.post("/api/units", async (c) => {
  const parsed = await parseJson(c, UnitInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO units (property_id, name, bedrooms, bathrooms, sqft, market_rent, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.property_id, d.name, d.bedrooms ?? 1, d.bathrooms ?? 1, d.sqft ?? null, d.market_rent ?? 0, d.status ?? "vacant", d.notes ?? null],
  );
  const row = await get(`${UNIT_SELECT} WHERE u.id = ?`, [result.lastInsertRowid]);
  return c.json({ unit: row }, 201);
});

app.put("/api/units/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, UnitInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE units SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(`${UNIT_SELECT} WHERE u.id = ?`, [id]);
  return c.json({ unit: row });
});

app.delete("/api/units/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM units WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Tenants ────────────────────────────────────────────────────────

const TenantInput = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  date_of_birth: z.string().optional().nullable(),
  emergency_contact: z.string().optional().nullable(),
  employer: z.string().optional().nullable(),
  monthly_income: z.number().optional().nullable(),
  notes: z.string().optional().nullable(),
});

app.get("/api/tenants", async (c) => {
  const search = c.req.query("q")?.trim();
  if (search) {
    const like = `%${search}%`;
    const rows = await query(
      `SELECT t.*,
         (SELECT u.id FROM leases l LEFT JOIN units u ON u.id = l.unit_id
            WHERE l.primary_tenant_id = t.id AND l.status = 'active' LIMIT 1) as active_unit_id,
         (SELECT u.name FROM leases l LEFT JOIN units u ON u.id = l.unit_id
            WHERE l.primary_tenant_id = t.id AND l.status = 'active' LIMIT 1) as active_unit_name,
         (SELECT p.name FROM leases l LEFT JOIN units u ON u.id = l.unit_id LEFT JOIN properties p ON p.id = u.property_id
            WHERE l.primary_tenant_id = t.id AND l.status = 'active' LIMIT 1) as active_property_name
       FROM tenants t
       WHERE t.last_name LIKE ? OR t.first_name LIKE ? OR t.email LIKE ? OR t.phone LIKE ?
       ORDER BY t.last_name, t.first_name LIMIT 200`,
      [like, like, like, like],
    );
    return c.json({ tenants: rows });
  }
  const rows = await query(
    `SELECT t.*,
       (SELECT u.id FROM leases l LEFT JOIN units u ON u.id = l.unit_id
          WHERE l.primary_tenant_id = t.id AND l.status = 'active' LIMIT 1) as active_unit_id,
       (SELECT u.name FROM leases l LEFT JOIN units u ON u.id = l.unit_id
          WHERE l.primary_tenant_id = t.id AND l.status = 'active' LIMIT 1) as active_unit_name,
       (SELECT p.name FROM leases l LEFT JOIN units u ON u.id = l.unit_id LEFT JOIN properties p ON p.id = u.property_id
          WHERE l.primary_tenant_id = t.id AND l.status = 'active' LIMIT 1) as active_property_name
     FROM tenants t ORDER BY t.last_name, t.first_name LIMIT 500`,
  );
  return c.json({ tenants: rows });
});

app.get("/api/tenants/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const row = await get("SELECT * FROM tenants WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ tenant: row });
});

app.post("/api/tenants", async (c) => {
  const parsed = await parseJson(c, TenantInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO tenants (first_name, last_name, email, phone, date_of_birth, emergency_contact, employer, monthly_income, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.first_name, d.last_name, d.email ?? null, d.phone ?? null, d.date_of_birth ?? null, d.emergency_contact ?? null, d.employer ?? null, d.monthly_income ?? null, d.notes ?? null],
  );
  const row = await get("SELECT * FROM tenants WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ tenant: row }, 201);
});

app.put("/api/tenants/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, TenantInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE tenants SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM tenants WHERE id = ?", [id]);
  return c.json({ tenant: row });
});

app.delete("/api/tenants/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM tenants WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Leases ─────────────────────────────────────────────────────────

const LeaseInput = z.object({
  unit_id: z.number().int(),
  primary_tenant_id: z.number().int().nullable().optional(),
  start_date: z.string(),
  end_date: z.string(),
  monthly_rent: z.number().min(0).optional(),
  deposit: z.number().min(0).optional(),
  rent_due_day: z.number().int().min(1).max(31).optional(),
  late_fee: z.number().min(0).optional(),
  status: z.enum(["upcoming", "active", "ended", "cancelled"]).optional(),
  notes: z.string().optional().nullable(),
});

const LEASE_SELECT = `
  SELECT l.*,
    u.name as unit_name,
    p.id as property_id, p.name as property_name, p.color as property_color,
    t.first_name as tenant_first_name, t.last_name as tenant_last_name,
    t.email as tenant_email, t.phone as tenant_phone
  FROM leases l
  LEFT JOIN units u ON u.id = l.unit_id
  LEFT JOIN properties p ON p.id = u.property_id
  LEFT JOIN tenants t ON t.id = l.primary_tenant_id
`;

app.get("/api/leases", async (c) => {
  const status = c.req.query("status");
  const tenantId = intParam(c.req.query("tenant_id"));
  const unitId = intParam(c.req.query("unit_id"));
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) { where.push("l.status = ?"); params.push(status); }
  if (tenantId) { where.push("l.primary_tenant_id = ?"); params.push(tenantId); }
  if (unitId) { where.push("l.unit_id = ?"); params.push(unitId); }
  const sql = `${LEASE_SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY l.start_date DESC`;
  const rows = await query(sql, params);
  return c.json({ leases: rows });
});

app.get("/api/leases/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const row = await get(`${LEASE_SELECT} WHERE l.id = ?`, [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ lease: row });
});

app.post("/api/leases", async (c) => {
  const parsed = await parseJson(c, LeaseInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO leases (unit_id, primary_tenant_id, start_date, end_date, monthly_rent, deposit, rent_due_day, late_fee, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.unit_id, d.primary_tenant_id ?? null, d.start_date, d.end_date, d.monthly_rent ?? 0, d.deposit ?? 0, d.rent_due_day ?? 1, d.late_fee ?? 0, d.status ?? "active", d.notes ?? null],
  );
  // Mark the unit as occupied if the new lease is active.
  if ((d.status ?? "active") === "active") {
    await run("UPDATE units SET status = 'occupied' WHERE id = ?", [d.unit_id]);
  }
  const row = await get(`${LEASE_SELECT} WHERE l.id = ?`, [result.lastInsertRowid]);
  return c.json({ lease: row }, 201);
});

app.put("/api/leases/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, LeaseInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE leases SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(`${LEASE_SELECT} WHERE l.id = ?`, [id]);
  return c.json({ lease: row });
});

app.delete("/api/leases/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM leases WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Rent charges & payments ────────────────────────────────────────

const ChargeInput = z.object({
  lease_id: z.number().int(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  due_date: z.string(),
  amount: z.number().min(0).optional(),
  notes: z.string().optional().nullable(),
});

const CHARGE_SELECT = `
  SELECT c.*,
    l.unit_id, l.monthly_rent as lease_rent, l.rent_due_day,
    u.name as unit_name,
    p.id as property_id, p.name as property_name, p.color as property_color,
    t.id as tenant_id, t.first_name as tenant_first_name, t.last_name as tenant_last_name
  FROM rent_charges c
  LEFT JOIN leases l ON l.id = c.lease_id
  LEFT JOIN units u ON u.id = l.unit_id
  LEFT JOIN properties p ON p.id = u.property_id
  LEFT JOIN tenants t ON t.id = l.primary_tenant_id
`;

app.get("/api/rent-charges", async (c) => {
  const period = c.req.query("period");
  const status = c.req.query("status");
  const where: string[] = [];
  const params: unknown[] = [];
  if (period) { where.push("c.period = ?"); params.push(period); }
  if (status) { where.push("c.status = ?"); params.push(status); }
  const sql = `${CHARGE_SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY c.due_date, p.name, u.name`;
  const rows = await query(sql, params).catch(() => []);
  return c.json({ charges: rows });
});

app.post("/api/rent-charges", async (c) => {
  const parsed = await parseJson(c, ChargeInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO rent_charges (lease_id, period, due_date, amount, notes) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lease_id, period) DO NOTHING`,
    [d.lease_id, d.period, d.due_date, d.amount ?? 0, d.notes ?? null],
  );
  if (!result.changes) {
    const existing = await get(`${CHARGE_SELECT} WHERE c.lease_id = ? AND c.period = ?`, [d.lease_id, d.period]);
    return c.json({ charge: existing });
  }
  const row = await get(`${CHARGE_SELECT} WHERE c.id = ?`, [result.lastInsertRowid]);
  return c.json({ charge: row }, 201);
});

// Generate (idempotent) charges for a given period across all active leases.
app.post("/api/rent-charges/generate", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { period?: string };
  const period = body.period;
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return c.json({ error: "period (YYYY-MM) required" }, 400);
  const leases = await query<{ id: number; monthly_rent: number; rent_due_day: number; start_date: string; end_date: string }>(
    "SELECT id, monthly_rent, rent_due_day, start_date, end_date FROM leases WHERE status = 'active'",
  );
  let created = 0;
  for (const l of leases) {
    // Skip if the lease doesn't cover this period at all.
    const periodStart = `${period}-01`;
    if (l.end_date < periodStart) continue;
    const day = String(Math.min(28, Math.max(1, l.rent_due_day))).padStart(2, "0");
    const dueDate = `${period}-${day}`;
    const r = await run(
      `INSERT INTO rent_charges (lease_id, period, due_date, amount) VALUES (?, ?, ?, ?)
         ON CONFLICT(lease_id, period) DO NOTHING`,
      [l.id, period, dueDate, l.monthly_rent],
    );
    if (r.changes) created++;
  }
  // Re-mark anything past due as 'overdue'.
  await run(
    `UPDATE rent_charges SET status = 'overdue'
     WHERE status IN ('open', 'partial') AND amount_paid < amount AND due_date < date('now')`,
  );
  return c.json({ created, period });
});

app.put("/api/rent-charges/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const Patch = z.object({
    amount: z.number().min(0).optional(),
    due_date: z.string().optional(),
    status: z.enum(["open", "partial", "paid", "overdue", "waived"]).optional(),
    notes: z.string().optional().nullable(),
  });
  const parsed = await parseJson(c, Patch);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE rent_charges SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(`${CHARGE_SELECT} WHERE c.id = ?`, [id]);
  return c.json({ charge: row });
});

app.delete("/api/rent-charges/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM rent_charges WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

const PaymentInput = z.object({
  charge_id: z.number().int(),
  paid_at: z.string().optional(),
  amount: z.number().min(0),
  method: z.enum(["cash", "check", "ach", "credit", "other"]).optional(),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

app.get("/api/rent-charges/:id/payments", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const rows = await query("SELECT * FROM payments WHERE charge_id = ? ORDER BY paid_at DESC", [id]);
  return c.json({ payments: rows });
});

app.post("/api/payments", async (c) => {
  const parsed = await parseJson(c, PaymentInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  await run(
    `INSERT INTO payments (charge_id, paid_at, amount, method, reference, notes)
     VALUES (?, COALESCE(?, datetime('now')), ?, ?, ?, ?)`,
    [d.charge_id, d.paid_at ?? null, d.amount, d.method ?? "cash", d.reference ?? null, d.notes ?? null],
  );
  // Recompute the charge's amount_paid + status.
  const charge = await get<{ amount: number }>("SELECT amount FROM rent_charges WHERE id = ?", [d.charge_id]);
  if (!charge) return c.json({ error: "Charge not found" }, 404);
  const sumRow = await get<{ total: number }>("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE charge_id = ?", [d.charge_id]);
  const paid = Number(sumRow?.total ?? 0);
  const status = paid >= charge.amount ? "paid" : paid > 0 ? "partial" : "open";
  await run("UPDATE rent_charges SET amount_paid = ?, status = ? WHERE id = ?", [paid, status, d.charge_id]);
  const updated = await get(`${CHARGE_SELECT} WHERE c.id = ?`, [d.charge_id]);
  return c.json({ charge: updated }, 201);
});

app.delete("/api/payments/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const row = await get<{ charge_id: number }>("SELECT charge_id FROM payments WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  await run("DELETE FROM payments WHERE id = ?", [id]);
  // Recompute the charge.
  const sumRow = await get<{ total: number }>("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE charge_id = ?", [row.charge_id]);
  const charge = await get<{ amount: number }>("SELECT amount FROM rent_charges WHERE id = ?", [row.charge_id]);
  const paid = Number(sumRow?.total ?? 0);
  const status = !charge ? "open" : paid >= charge.amount ? "paid" : paid > 0 ? "partial" : "open";
  await run("UPDATE rent_charges SET amount_paid = ?, status = ? WHERE id = ?", [paid, status, row.charge_id]);
  return c.json({ ok: true });
});

// ── Vendors ────────────────────────────────────────────────────────

const VendorInput = z.object({
  name: z.string().min(1),
  category: z.enum(["plumber", "electrician", "hvac", "handyman", "cleaning", "landscaping", "general"]).optional(),
  phone: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  color: z.string().optional(),
});

app.get("/api/vendors", async (c) => {
  const rows = await query("SELECT * FROM vendors ORDER BY name");
  return c.json({ vendors: rows });
});

app.post("/api/vendors", async (c) => {
  const parsed = await parseJson(c, VendorInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    "INSERT INTO vendors (name, category, phone, email, notes, color) VALUES (?, ?, ?, ?, ?, ?)",
    [d.name, d.category ?? "general", d.phone ?? null, d.email ?? null, d.notes ?? null, d.color ?? "slate"],
  );
  const row = await get("SELECT * FROM vendors WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ vendor: row }, 201);
});

app.put("/api/vendors/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, VendorInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE vendors SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM vendors WHERE id = ?", [id]);
  return c.json({ vendor: row });
});

app.delete("/api/vendors/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM vendors WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Work orders ────────────────────────────────────────────────────

const WorkOrderInput = z.object({
  property_id: z.number().int().nullable().optional(),
  unit_id: z.number().int().nullable().optional(),
  tenant_id: z.number().int().nullable().optional(),
  vendor_id: z.number().int().nullable().optional(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  status: z.enum(["open", "assigned", "in_progress", "pending_owner_decision", "completed", "cancelled"]).optional(),
  scheduled_at: z.string().optional().nullable(),
  completed_at: z.string().optional().nullable(),
  cost: z.number().min(0).optional().nullable(),
  notes: z.string().optional().nullable(),
});

const TicketTimelineInput = z.object({
  type: z.enum(TIMELINE_TYPES).default("note"),
  sender_contact_id: z.number().int().nullable().optional(),
  message_body: z.string().min(1),
  timestamp: z.string().optional(),
});

const ExpenseInput = z.object({
  property_id: z.number().int(),
  amount_owed: z.number().min(0),
  amount_paid: z.number().min(0).optional().default(0),
  date_paid: z.string().nullable().optional(),
  payment_source: z.enum(PAYMENT_SOURCES).nullable().optional(),
});

const MergeTicketInput = z.object({
  source_ticket_id: z.number().int().positive(),
  destination_ticket_id: z.number().int().positive(),
});

const EmailIngestInput = z.object({
  sender_email: z.string().email().optional(),
  sender_name: z.string().optional().nullable(),
  from_email: z.string().email().optional(),
  from_name: z.string().optional().nullable(),
  subject: z.string().optional().nullable(),
  body_text: z.string().optional().nullable(),
  body: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  if (!(value.sender_email ?? value.from_email)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sender_email or from_email is required" });
  }
  if (!(value.body_text ?? value.body)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "body_text or body is required" });
  }
});

const WO_SELECT = `
  SELECT w.*,
    p.name as property_name, p.color as property_color,
    u.name as unit_name,
    t.first_name as tenant_first_name, t.last_name as tenant_last_name,
    v.name as vendor_name, v.color as vendor_color
  FROM work_orders w
  LEFT JOIN properties p ON p.id = w.property_id
  LEFT JOIN units u ON u.id = w.unit_id
  LEFT JOIN tenants t ON t.id = w.tenant_id
  LEFT JOIN vendors v ON v.id = w.vendor_id
`;

type TicketDecision = { action: "append"; ticket_id: number; reason: string } | { action: "create_new"; suggested_title: string; reason: string };

function normalizeDecision(
  parsed: unknown,
  activeIds: number[],
  fallbackTitle: string,
): TicketDecision {
  if (!parsed || typeof parsed !== "object") {
    return { action: "create_new", suggested_title: fallbackTitle, reason: "AI output was not a JSON object." };
  }

  const action = (parsed as { action?: unknown }).action;
  if (action === "append") {
    const rawId = (parsed as { ticket_id?: unknown }).ticket_id;
    const ticketId = Number(rawId);
    const reason = String((parsed as { reason?: unknown }).reason ?? "Matched by AI classifier.");
    if (Number.isInteger(ticketId) && activeIds.includes(ticketId)) {
      return { action: "append", ticket_id: ticketId, reason };
    }
  }

  const suggestedTitle = String((parsed as { suggested_title?: unknown }).suggested_title ?? fallbackTitle).trim() || fallbackTitle;
  const reason = String((parsed as { reason?: unknown }).reason ?? "No confident match to active tickets.");
  return { action: "create_new", suggested_title: suggestedTitle, reason };
}

async function classifyEmailToTicket(
  ai: WorkersAI | undefined,
  payload: { subject: string; bodyText: string; activeTickets: Array<{ id: number; title: string; description: string | null; status: string }> },
): Promise<TicketDecision> {
  const fallbackTitle = payload.subject.trim() || "Auto-created ticket from email";
  const activeIds = payload.activeTickets.map((ticket) => ticket.id);
  if (!activeIds.length) return { action: "create_new", suggested_title: fallbackTitle, reason: "No active work orders found." };
  if (!ai) return { action: "create_new", suggested_title: fallbackTitle, reason: "Workers AI binding unavailable; created new ticket." };

  const systemPrompt = `You match incoming maintenance emails to active work orders.
Return only strict JSON with one of:
{"action":"append","ticket_id":number,"reason":"string"}
{"action":"create_new","suggested_title":"string","reason":"string"}
Only use a ticket_id from the provided active work orders.`;

  const userPrompt = JSON.stringify({
    email: { subject: payload.subject, body: payload.bodyText },
    active_work_orders: payload.activeTickets,
  });

  try {
    const result = await ai.run("@cf/meta/llama-3-8b-instruct", {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 300,
      temperature: 0.1,
    });

    const response =
      typeof result === "string"
        ? result
        : typeof (result as { response?: unknown }).response === "string"
          ? String((result as { response?: unknown }).response)
          : "";

    const json = extractJsonObject(response);
    if (!json) return { action: "create_new", suggested_title: fallbackTitle, reason: "AI response did not contain JSON." };
    return normalizeDecision(JSON.parse(json), activeIds, fallbackTitle);
  } catch {
    return { action: "create_new", suggested_title: fallbackTitle, reason: "Workers AI classification failed." };
  }
}

app.get("/api/work-orders", async (c) => {
  const status = c.req.query("status");
  const propertyId = intParam(c.req.query("property_id"));
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) { where.push("w.status = ?"); params.push(status); }
  if (propertyId) { where.push("w.property_id = ?"); params.push(propertyId); }
  const sql = `${WO_SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY
    CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
    w.created_at DESC`;
  const rows = await query(sql, params).catch(() => []);
  return c.json({ work_orders: rows });
});

app.post("/api/work-orders", async (c) => {
  const parsed = await parseJson(c, WorkOrderInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO work_orders (property_id, unit_id, tenant_id, vendor_id, title, description, priority, status, scheduled_at, completed_at, cost, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.property_id ?? null, d.unit_id ?? null, d.tenant_id ?? null, d.vendor_id ?? null,
      d.title, d.description ?? null,
      d.priority ?? "normal", d.status ?? "open",
      d.scheduled_at ?? null, d.completed_at ?? null,
      d.cost ?? null, d.notes ?? null,
    ],
  );
  const row = await get(`${WO_SELECT} WHERE w.id = ?`, [result.lastInsertRowid]);
  return c.json({ work_order: row }, 201);
});

app.post("/api/work-orders/merge", async (c) => {
  const parsed = await parseJson(c, MergeTicketInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { source_ticket_id: sourceId, destination_ticket_id: destinationId } = parsed.data;
  if (sourceId === destinationId) return c.json({ error: "Source and destination must differ" }, 400);

  const [source, destination] = await Promise.all([
    get<{ id: number; title: string }>("SELECT id, title FROM work_orders WHERE id = ?", [sourceId]),
    get<{ id: number; title: string }>("SELECT id, title FROM work_orders WHERE id = ?", [destinationId]),
  ]);
  if (!source || !destination) return c.json({ error: "One or both tickets were not found" }, 404);

  try {
    await run("BEGIN");
    const destinationMax = await get<{ timestamp: string | null }>(
      "SELECT MAX(timestamp) as timestamp FROM ticket_timeline WHERE ticket_id = ?",
      [destinationId],
    );
    const baseMs = parseDateToMs(destinationMax?.timestamp) + 1000;
    const sourceTimeline = await query<{ id: number }>(
      "SELECT id FROM ticket_timeline WHERE ticket_id = ? ORDER BY timestamp ASC, id ASC",
      [sourceId],
    );

    for (let i = 0; i < sourceTimeline.length; i++) {
      const row = sourceTimeline[i];
      const timestamp = new Date(baseMs + i * 1000).toISOString();
      await run("UPDATE ticket_timeline SET ticket_id = ?, timestamp = ? WHERE id = ?", [destinationId, timestamp, row.id]);
    }

    await run(
      "INSERT INTO ticket_timeline (ticket_id, type, message_body, timestamp) VALUES (?, 'system_activity', ?, ?)",
      [destinationId, `Merged ticket #${sourceId} (${source.title}) into this ticket.`, isoNow()],
    );
    await run(
      "INSERT INTO ticket_timeline (ticket_id, type, message_body, timestamp) VALUES (?, 'system_activity', ?, ?)",
      [sourceId, `Ticket merged into #${destinationId} (${destination.title}).`, isoNow()],
    );

    await run("UPDATE expenses SET work_order_id = ?, updated_at = datetime('now') WHERE work_order_id = ?", [destinationId, sourceId]);
    await run("DELETE FROM work_orders WHERE id = ?", [sourceId]);
    await run("COMMIT");
  } catch {
    await run("ROLLBACK").catch(() => null);
    return c.json({ error: "Unable to merge tickets" }, 500);
  }

  const row = await get(`${WO_SELECT} WHERE w.id = ?`, [destinationId]);
  return c.json({ work_order: row, merged_from: sourceId, merged_into: destinationId });
});

app.put("/api/work-orders/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, WorkOrderInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE work_orders SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(`${WO_SELECT} WHERE w.id = ?`, [id]);
  return c.json({ work_order: row });
});

app.delete("/api/work-orders/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM work_orders WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

app.get("/api/work-orders/:id/timeline", async (c) => {
  const ticketId = intParam(c.req.param("id"));
  if (!ticketId) return c.json({ error: "Invalid ID" }, 400);
  const timeline = await query(
    `SELECT tt.*,
      ct.name as sender_name,
      ct.email_address as sender_email_address,
      ct.company_name as sender_company_name
     FROM ticket_timeline tt
     LEFT JOIN contacts ct ON ct.id = tt.sender_contact_id
     WHERE tt.ticket_id = ?
     ORDER BY tt.timestamp ASC, tt.id ASC`,
    [ticketId],
  ).catch(() => []);
  return c.json({ timeline });
});

app.post("/api/work-orders/:id/timeline", async (c) => {
  const ticketId = intParam(c.req.param("id"));
  if (!ticketId) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, TicketTimelineInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    "INSERT INTO ticket_timeline (ticket_id, type, sender_contact_id, message_body, timestamp) VALUES (?, ?, ?, ?, ?)",
    [ticketId, d.type, d.sender_contact_id ?? null, d.message_body, d.timestamp ?? isoNow()],
  );
  const row = await get(
    `SELECT tt.*,
      ct.name as sender_name,
      ct.email_address as sender_email_address,
      ct.company_name as sender_company_name
     FROM ticket_timeline tt
     LEFT JOIN contacts ct ON ct.id = tt.sender_contact_id
     WHERE tt.id = ?`,
    [result.lastInsertRowid],
  );
  return c.json({ timeline_item: row }, 201);
});

app.get("/api/work-orders/:id/expenses", async (c) => {
  const ticketId = intParam(c.req.param("id"));
  if (!ticketId) return c.json({ error: "Invalid ID" }, 400);
  const expenses = await query("SELECT * FROM expenses WHERE work_order_id = ? ORDER BY COALESCE(date_paid, created_at) DESC, id DESC", [ticketId]).catch(() => []);
  return c.json({ expenses });
});

app.post("/api/work-orders/:id/expenses", async (c) => {
  const ticketId = intParam(c.req.param("id"));
  if (!ticketId) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, ExpenseInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO expenses (property_id, work_order_id, amount_owed, amount_paid, date_paid, payment_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [d.property_id, ticketId, d.amount_owed, d.amount_paid ?? 0, d.date_paid ?? null, d.payment_source ?? null],
  );
  const row = await get("SELECT * FROM expenses WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ expense: row }, 201);
});

app.put("/api/expenses/:id", async (c) => {
  const expenseId = intParam(c.req.param("id"));
  if (!expenseId) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, ExpenseInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(expenseId);
  const result = await run(`UPDATE expenses SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!result.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM expenses WHERE id = ?", [expenseId]);
  return c.json({ expense: row });
});

app.delete("/api/expenses/:id", async (c) => {
  const expenseId = intParam(c.req.param("id"));
  if (!expenseId) return c.json({ error: "Invalid ID" }, 400);
  const result = await run("DELETE FROM expenses WHERE id = ?", [expenseId]);
  if (!result.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

app.get("/api/expenses/summary", async (c) => {
  const summary = await get<{ owner_capital_injected: number; total_amount_owed: number; total_amount_paid: number }>(
    `SELECT
      COALESCE(SUM(CASE WHEN payment_source = 'Owner Contribution' THEN amount_paid ELSE 0 END), 0) as owner_capital_injected,
      COALESCE(SUM(amount_owed), 0) as total_amount_owed,
      COALESCE(SUM(amount_paid), 0) as total_amount_paid
     FROM expenses`,
  );
  return c.json({
    owner_capital_injected: summary?.owner_capital_injected ?? 0,
    total_amount_owed: summary?.total_amount_owed ?? 0,
    total_amount_paid: summary?.total_amount_paid ?? 0,
  });
});

app.post("/api/emails/ingest", async (c) => {
  const parsed = await parseJson(c, EmailIngestInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const senderEmail = (parsed.data.sender_email ?? parsed.data.from_email ?? "").trim().toLowerCase();
  const senderName = (parsed.data.sender_name ?? parsed.data.from_name ?? "").trim() || null;
  const subject = (parsed.data.subject ?? "").trim();
  const bodyText = (parsed.data.body_text ?? parsed.data.body ?? "").trim();
  const companyName = c.env.AI_COMPANY_NAME ?? null;

  let contact = await get<{ id: number; email_address: string }>("SELECT id, email_address FROM contacts WHERE lower(email_address) = lower(?)", [senderEmail]);
  if (!contact) {
    const created = await run(
      "INSERT INTO contacts (name, email_address, company_name) VALUES (?, ?, ?)",
      [senderName, senderEmail, companyName],
    );
    contact = await get<{ id: number; email_address: string }>("SELECT id, email_address FROM contacts WHERE id = ?", [created.lastInsertRowid]);
  }
  if (!contact) return c.json({ error: "Unable to resolve contact" }, 500);

  const activeTickets = await query<{ id: number; title: string; description: string | null; status: string }>(
    `SELECT id, title, description, status
     FROM work_orders
     WHERE status IN (${ACTIVE_WORK_ORDER_STATUSES.map(() => "?").join(", ")})
     ORDER BY created_at DESC`,
    [...ACTIVE_WORK_ORDER_STATUSES],
  ).catch(() => []);

  const decision = await classifyEmailToTicket(c.env.AI, { subject, bodyText, activeTickets });
  let ticketId = decision.action === "append" ? decision.ticket_id : 0;

  if (decision.action === "create_new") {
    const newTicket = await run(
      `INSERT INTO work_orders (title, description, status, priority, notes)
       VALUES (?, ?, 'pending_owner_decision', 'normal', ?)`,
      [decision.suggested_title, bodyText.slice(0, 1500) || null, decision.reason],
    );
    ticketId = Number(newTicket.lastInsertRowid);
  }

  await run(
    "INSERT INTO ticket_timeline (ticket_id, type, sender_contact_id, message_body, timestamp) VALUES (?, 'email', ?, ?, ?)",
    [ticketId, contact.id, bodyText, isoNow()],
  );
  await run(
    "INSERT INTO ticket_timeline (ticket_id, type, message_body, timestamp) VALUES (?, 'system_activity', ?, ?)",
    [ticketId, decision.reason, isoNow()],
  );

  const workOrder = await get(`${WO_SELECT} WHERE w.id = ?`, [ticketId]);
  return c.json({
    action: decision.action,
    ticket_id: ticketId,
    reason: decision.reason,
    contact_id: contact.id,
    work_order: workOrder,
  });
});

// ── Applications ───────────────────────────────────────────────────

const ApplicationInput = z.object({
  unit_id: z.number().int().nullable().optional(),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  monthly_income: z.number().optional().nullable(),
  employer: z.string().optional().nullable(),
  desired_move_in: z.string().optional().nullable(),
  status: z.enum(["new", "screening", "approved", "declined", "withdrawn"]).optional(),
  notes: z.string().optional().nullable(),
});

app.get("/api/applications", async (c) => {
  const rows = await query(
    `SELECT a.*, u.name as unit_name, p.name as property_name
     FROM applications a
     LEFT JOIN units u ON u.id = a.unit_id
     LEFT JOIN properties p ON p.id = u.property_id
     ORDER BY a.created_at DESC`,
  ).catch(() => []);
  return c.json({ applications: rows });
});

app.post("/api/applications", async (c) => {
  const parsed = await parseJson(c, ApplicationInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO applications (unit_id, first_name, last_name, email, phone, monthly_income, employer, desired_move_in, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.unit_id ?? null, d.first_name, d.last_name,
      d.email ?? null, d.phone ?? null, d.monthly_income ?? null, d.employer ?? null,
      d.desired_move_in ?? null, d.status ?? "new", d.notes ?? null,
    ],
  );
  const row = await get(
    `SELECT a.*, u.name as unit_name, p.name as property_name
     FROM applications a LEFT JOIN units u ON u.id = a.unit_id LEFT JOIN properties p ON p.id = u.property_id
     WHERE a.id = ?`,
    [result.lastInsertRowid],
  );
  return c.json({ application: row }, 201);
});

app.put("/api/applications/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, ApplicationInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { sets, params } = buildUpdate(parsed.data);
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE applications SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(
    `SELECT a.*, u.name as unit_name, p.name as property_name
     FROM applications a LEFT JOIN units u ON u.id = a.unit_id LEFT JOIN properties p ON p.id = u.property_id
     WHERE a.id = ?`,
    [id],
  );
  return c.json({ application: row });
});

app.delete("/api/applications/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM applications WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Dashboard summary ──────────────────────────────────────────────

app.get("/api/dashboard/summary", async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const periodNow = today.slice(0, 7);

  const safeGet = <T,>(sql: string, params: unknown[] = [], fallback: T) =>
    get<T>(sql, params).catch(() => fallback as T | undefined).then((v) => v ?? fallback);
  const safeQuery = <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
    query<T>(sql, params).catch(() => [] as T[]);

  const [
    propertyCount,
    unitCount,
    occupiedCount,
    vacantCount,
    activeLeases,
    upcomingMoveOuts,
    monthOutstanding,
    monthCollected,
    overdueRow,
    openWorkOrders,
    urgentWorkOrders,
    recentWorkOrders,
    upcomingExpirations,
  ] = await Promise.all([
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM properties", [], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM units", [], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM units WHERE status = 'occupied'", [], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM units WHERE status = 'vacant'", [], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM leases WHERE status = 'active'", [], { n: 0 }),
    safeGet<{ n: number }>(
      "SELECT COUNT(*) as n FROM leases WHERE status = 'active' AND end_date <= date('now', '+30 days')",
      [], { n: 0 },
    ),
    safeGet<{ total: number }>(
      "SELECT COALESCE(SUM(amount - amount_paid), 0) as total FROM rent_charges WHERE period = ? AND status != 'waived'",
      [periodNow], { total: 0 },
    ),
    safeGet<{ total: number }>(
      "SELECT COALESCE(SUM(amount_paid), 0) as total FROM rent_charges WHERE period = ?",
      [periodNow], { total: 0 },
    ),
    safeGet<{ total: number; n: number }>(
      "SELECT COALESCE(SUM(amount - amount_paid), 0) as total, COUNT(*) as n FROM rent_charges WHERE due_date < date('now') AND amount_paid < amount AND status != 'waived'",
      [], { total: 0, n: 0 },
    ),
    safeGet<{ n: number }>(
      "SELECT COUNT(*) as n FROM work_orders WHERE status NOT IN ('completed', 'cancelled')",
      [], { n: 0 },
    ),
    safeGet<{ n: number }>(
      "SELECT COUNT(*) as n FROM work_orders WHERE priority = 'urgent' AND status NOT IN ('completed', 'cancelled')",
      [], { n: 0 },
    ),
    safeQuery<{ id: number; title: string; priority: string; status: string; property_name: string | null; unit_name: string | null; created_at: string }>(
      `SELECT w.id, w.title, w.priority, w.status, p.name as property_name, u.name as unit_name, w.created_at
       FROM work_orders w
       LEFT JOIN properties p ON p.id = w.property_id
       LEFT JOIN units u ON u.id = w.unit_id
       WHERE w.status NOT IN ('completed', 'cancelled')
       ORDER BY CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, w.created_at DESC
       LIMIT 6`,
    ),
    safeQuery<{ id: number; end_date: string; tenant_first_name: string | null; tenant_last_name: string | null; unit_name: string | null; property_name: string | null }>(
      `SELECT l.id, l.end_date,
         t.first_name as tenant_first_name, t.last_name as tenant_last_name,
         u.name as unit_name, p.name as property_name
       FROM leases l
       LEFT JOIN tenants t ON t.id = l.primary_tenant_id
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       WHERE l.status = 'active' AND l.end_date <= date('now', '+60 days')
       ORDER BY l.end_date ASC LIMIT 6`,
    ),
  ]);

  return c.json({
    period: periodNow,
    properties: propertyCount.n,
    units: unitCount.n,
    occupied: occupiedCount.n,
    vacant: vacantCount.n,
    occupancy_rate: unitCount.n ? Math.round((occupiedCount.n / unitCount.n) * 100) : 0,
    active_leases: activeLeases.n,
    upcoming_move_outs: upcomingMoveOuts.n,
    month_outstanding: monthOutstanding.total,
    month_collected: monthCollected.total,
    overdue_total: overdueRow.total,
    overdue_count: overdueRow.n,
    open_work_orders: openWorkOrders.n,
    urgent_work_orders: urgentWorkOrders.n,
    recent_work_orders: recentWorkOrders,
    upcoming_expirations: upcomingExpirations,
  });
});

// ── Settings (key/value) ───────────────────────────────────────────

app.get("/api/settings", async (c) => {
  const rows = await query<{ key: string; value: string }>("SELECT key, value FROM settings").catch(() => []);
  // Defaults first, so a caller always gets a currency and a due day even if
  // the seed has not run yet (a brand-new database, or a deleted row).
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return c.json({ settings: out });
});

app.put("/api/settings", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  if (!body || typeof body !== "object") return c.json({ error: "Body must be an object" }, 400);
  const entries = Object.entries(body as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null);
  for (const [key, value] of entries) {
    await run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [key, String(value)],
    );
  }
  const rows = await query<{ key: string; value: string }>("SELECT key, value FROM settings");
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return c.json({ settings: out });
});

// ── Health ─────────────────────────────────────────────────────────

app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
