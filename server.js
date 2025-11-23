import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db, { run, get, all } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

// Ensure uploads dir exists
fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });

// CORS
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";
app.use(
  cors({
    origin: corsOrigin.split(",").map((o) => o.trim()),
  })
);

app.use(express.json());

// ---------- Multer for CSV upload ----------
const upload = multer({ dest: path.join(__dirname, "uploads") });

// ---------- Helpers ----------
function validateProductFields(body) {
  const required = ["name", "unit", "category", "brand", "stock", "status"];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      return `${field} is required`;
    }
  }
  if (isNaN(Number(body.stock)) || Number(body.stock) < 0) {
    return "stock must be a number >= 0";
  }
  return null;
}

// ---------- GET /api/products (optional category filter) ----------
app.get("/api/products", async (req, res) => {
  try {
    const { category } = req.query;

    let where = "";
    const params = [];
    if (category && category !== "All") {
      where = "WHERE category = ?";
      params.push(category);
    }

    const products = await all(
      `SELECT * FROM products ${where} ORDER BY id DESC`,
      params
    );

    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// ---------- GET /api/products/search?name=... ----------
app.get("/api/products/search", async (req, res) => {
  try {
    const { name = "" } = req.query;
    const query = `%${name.toLowerCase()}%`;

    const products = await all(
      "SELECT * FROM products WHERE LOWER(name) LIKE ? ORDER BY id DESC",
      [query]
    );

    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to search products" });
  }
});

// ---------- POST /api/products (create) ----------
app.post("/api/products", async (req, res) => {
  try {
    const error = validateProductFields(req.body);
    if (error) return res.status(400).json({ error });

    const { name, unit, category, brand, stock, status, image } = req.body;

    const existing = await get(
      "SELECT * FROM products WHERE LOWER(name) = LOWER(?)",
      [name]
    );
    if (existing) {
      return res.status(400).json({ error: "Product name already exists" });
    }

    const result = await run(
      `
      INSERT INTO products (name, unit, category, brand, stock, status, image, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
      [name, unit, category, brand, Number(stock), status, image || ""]
    );

    const newProduct = await get("SELECT * FROM products WHERE id = ?", [
      result.id,
    ]);

    res.status(201).json(newProduct);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create product" });
  }
});

// ---------- PUT /api/products/:id (update + log stock change) ----------
app.put("/api/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const error = validateProductFields(req.body);
    if (error) return res.status(400).json({ error });

    const { name, unit, category, brand, stock, status, image } = req.body;

    const existingProduct = await get("SELECT * FROM products WHERE id = ?", [
      id,
    ]);
    if (!existingProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    const duplicate = await get(
      "SELECT * FROM products WHERE LOWER(name) = LOWER(?) AND id != ?",
      [name, id]
    );
    if (duplicate) {
      return res.status(400).json({ error: "Product name must be unique" });
    }

    const newStock = Number(stock);
    const oldStock = existingProduct.stock;

    await run(
      `
      UPDATE products
      SET name = ?, unit = ?, category = ?, brand = ?, stock = ?, status = ?, image = ?, updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      [name, unit, category, brand, newStock, status, image || "", id]
    );

    if (newStock !== oldStock) {
      await run(
        `
        INSERT INTO inventory_logs (productId, oldStock, newStock, changedBy)
        VALUES (?, ?, ?, ?)
      `,
        [id, oldStock, newStock, "admin"]
      );
    }

    const updatedProduct = await get("SELECT * FROM products WHERE id = ?", [
      id,
    ]);
    res.json(updatedProduct);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update product" });
  }
});

// ---------- DELETE /api/products/:id ----------
app.delete("/api/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const existing = await get("SELECT * FROM products WHERE id = ?", [id]);
    if (!existing) {
      return res.status(404).json({ error: "Product not found" });
    }

    await run("DELETE FROM products WHERE id = ?", [id]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// ---------- GET /api/products/:id/history ----------
app.get("/api/products/:id/history", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const logs = await all(
      `
      SELECT * FROM inventory_logs
      WHERE productId = ?
      ORDER BY datetime(timestamp) DESC
    `,
      [id]
    );

    res.json(logs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// ---------- POST /api/products/import (CSV) ----------
app.post("/api/products/import", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "CSV file is required" });
  }

  const filePath = req.file.path;
  const added = [];
  const skipped = [];
  const duplicates = [];

  try {
    const rows = await new Promise((resolve, reject) => {
      const results = [];
      fs.createReadStream(filePath)
        .pipe(csv())
        .on("data", (data) => results.push(data))
        .on("end", () => resolve(results))
        .on("error", (err) => reject(err));
    });

    for (const row of rows) {
      const name = row.name?.trim();
      const unit = row.unit?.trim();
      const category = row.category?.trim();
      const brand = row.brand?.trim();
      const stock = Number(row.stock || 0);
      const status = row.status?.trim() || "In Stock";
      const image = row.image?.trim() || "";

      if (!name || !unit || !category || !brand) {
        skipped.push({ name, reason: "Missing required fields" });
        continue;
      }

      const existing = await get(
        "SELECT id FROM products WHERE LOWER(name) = LOWER(?)",
        [name]
      );

      if (existing) {
        duplicates.push({ name, existingId: existing.id });
        continue;
      }

      const result = await run(
        `
        INSERT INTO products (name, unit, category, brand, stock, status, image, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
        [name, unit, category, brand, stock, status, image]
      );

      added.push(result.id);
    }

    res.json({
      added: added.length,
      skipped: skipped.length,
      duplicates,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to import CSV" });
  } finally {
    fs.unlink(filePath, () => {});
  }
});

// ---------- GET /api/products/export (CSV) ----------
app.get("/api/products/export", async (req, res) => {
  try {
    const products = await all("SELECT * FROM products", []);

    let csvContent = "id,name,unit,category,brand,stock,status,image,createdAt,updatedAt\n";
    for (const p of products) {
      const row = [
        p.id,
        JSON.stringify(p.name),
        JSON.stringify(p.unit),
        JSON.stringify(p.category),
        JSON.stringify(p.brand),
        p.stock,
        JSON.stringify(p.status),
        JSON.stringify(p.image || ""),
        JSON.stringify(p.createdAt || ""),
        JSON.stringify(p.updatedAt || ""),
      ].join(",");
      csvContent += row + "\n";
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="products_export.csv"'
    );
    res.send(csvContent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to export CSV" });
  }
});

// ---------- Root ----------
app.get("/", (req, res) => {
  res.send("Product Inventory API is running");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
