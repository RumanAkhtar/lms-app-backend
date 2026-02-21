import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

/* ===================================================== */
/* LOAD ENV                                              */
/* ===================================================== */

dotenv.config();

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PORT,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing Supabase credentials in environment variables");
  process.exit(1);
}

/* ===================================================== */
/* EXPRESS SETUP                                         */
/* ===================================================== */

const app = express();

app.use(
  cors({
    origin: "*", // Later restrict to your domain if needed
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

app.use(express.json({ limit: "10mb" }));

/* ===================================================== */
/* SUPABASE CLIENT (ADMIN - SERVICE ROLE)               */
/* ===================================================== */

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

/* ===================================================== */
/* GLOBAL ERROR HANDLER WRAPPER                         */
/* ===================================================== */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/* ===================================================== */
/* HEALTH CHECK                                          */
/* ===================================================== */

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "🚀 LMS Backend API running",
  });
});

/* ===================================================== */
/* USERS                                                 */
/* ===================================================== */

app.get(
  "/api/users",
  asyncHandler(async (req, res) => {
    const { role } = req.query;

    let query = supabase
      .from("profiles")
      .select("*")
      .order("name", { ascending: true });

    if (role) query = query.eq("role", role);

    const { data, error } = await query;
    if (error) throw error;

    res.status(200).json(data);
  })
);

/* CREATE INSTRUCTOR */

app.post(
  "/api/instructors",
  asyncHandler(async (req, res) => {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check existing
    const { data: existing } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: "User already exists" });
    }

    // Create auth user
    const { data: userData, error: authError } =
      await supabase.auth.admin.createUser({
        email: normalizedEmail,
        email_confirm: true,
      });

    if (authError) throw authError;

    const userId = userData.user.id;

    // Create profile
    const { error: profileError } = await supabase
      .from("profiles")
      .insert({
        id: userId,
        name,
        email: normalizedEmail,
        role: "instructor",
      });

    if (profileError) {
      await supabase.auth.admin.deleteUser(userId);
      throw profileError;
    }

    res.status(201).json({
      success: true,
      message: "Instructor created successfully",
      userId,
    });
  })
);

/* ===================================================== */
/* COURSES                                               */
/* ===================================================== */

app.get(
  "/api/courses",
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from("courses")
      .select(`
        id,
        title,
        short_desc,
        thumbnail_url,
        category,
        level,
        language,
        status,
        is_paid,
        price,
        created_at,
        profiles:instructor_id ( id, name )
      `)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.status(200).json(data);
  })
);

app.get(
  "/api/courses/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("courses")
      .select(`*, profiles:instructor_id ( id, name )`)
      .eq("id", id)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ error: "Course not found" });
      }
      throw error;
    }

    res.status(200).json(data);
  })
);

app.post(
  "/api/courses",
  asyncHandler(async (req, res) => {
    const { title, short_desc, instructor_id, ...rest } = req.body;

    if (!title || !short_desc || !instructor_id) {
      return res
        .status(400)
        .json({ error: "title, short_desc, instructor_id required" });
    }

    const { data, error } = await supabase
      .from("courses")
      .insert({
        title,
        short_desc,
        instructor_id,
        status: rest.status || "draft",
        ...rest,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  })
);

app.put(
  "/api/courses/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("courses")
      .update(req.body)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json(data);
  })
);

app.delete(
  "/api/courses/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { error } = await supabase
      .from("courses")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: "Course deleted successfully",
    });
  })
);

/* ===================================================== */
/* CURRICULUM                                            */
/* ===================================================== */

app.get(
  "/api/courses/:id/curriculum",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("course_modules")
      .select(`
        id, title, order_index,
        lessons:course_lessons (
          id, title, type, url, order_index,
          files:lesson_files (
            id, name, file_url, file_size
          )
        )
      `)
      .eq("course_id", id)
      .order("order_index", { ascending: true })
      .order("order_index", {
        foreignTable: "course_lessons",
        ascending: true,
      });

    if (error) throw error;

    res.status(200).json(data);
  })
);

/* ===================================================== */
/* GLOBAL ERROR HANDLER                                  */
/* ===================================================== */

app.use((err, req, res, next) => {
  console.error("🚨 SERVER ERROR:", err);
  res.status(500).json({
    error: "Internal Server Error",
    message: err.message,
  });
});

/* ===================================================== */
/* START SERVER                                          */
/* ===================================================== */

const serverPort = PORT || 5050;

app.listen(serverPort, "0.0.0.0", () => {
  console.log(`🚀 LMS Backend running on port ${serverPort}`);
});