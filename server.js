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
  console.error("❌ Missing Supabase credentials");
  process.exit(1);
}

/* ===================================================== */
/* EXPRESS SETUP                                         */
/* ===================================================== */

const app = express();

app.use(
  cors({
    origin: "*", // Restrict in production
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

app.use(express.json({ limit: "10mb" }));

/* ===================================================== */
/* SUPABASE ADMIN CLIENT                                */
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
/* ASYNC WRAPPER                                         */
/* ===================================================== */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/* ===================================================== */
/* AUTH MIDDLEWARE                                       */
/* ===================================================== */

const verifyToken = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  const token = authHeader.split(" ")[1];

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.user = data.user;
  next();
});

const requireAdmin = asyncHandler(async (req, res, next) => {
  const userId = req.user.id;

  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();

  if (error || data?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
});

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
/* USERS (ADMIN ONLY)                                    */
/* ===================================================== */

app.get(
  "/api/users",
  verifyToken,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { role } = req.query;

    let query = supabase
      .from("profiles")
      .select("id, name, role, avatar, created_at")
      .order("name", { ascending: true });

    if (role) query = query.eq("role", role);

    const { data, error } = await query;
    if (error) throw error;

    res.status(200).json(data);
  })
);

/* ===================================================== */
/* INSTRUCTORS                                           */
/* ===================================================== */

app.get(
  "/api/instructors",
  verifyToken,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, name, avatar, created_at")
      .eq("role", "instructor")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.status(200).json(data);
  })
);

app.post(
  "/api/instructors",
  verifyToken,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        error: "Name and email are required",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Create auth user
    const { data: userData, error: authError } =
      await supabase.auth.admin.createUser({
        email: normalizedEmail,
        email_confirm: true,
      });

    if (authError) throw authError;

    const userId = userData.user.id;

    const { error: profileError } = await supabase
      .from("profiles")
      .insert({
        id: userId,
        name,
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
/* COURSES (ADMIN ONLY)                                  */
/* ===================================================== */

app.get(
  "/api/courses",
  verifyToken,
  requireAdmin,
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
        status,
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
  verifyToken,
  requireAdmin,
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
  verifyToken,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { title, short_desc, instructor_id, ...rest } = req.body;

    if (!title || !short_desc || !instructor_id) {
      return res.status(400).json({
        error: "title, short_desc, instructor_id required",
      });
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
  verifyToken,
  requireAdmin,
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
  verifyToken,
  requireAdmin,
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
  verifyToken,
  requireAdmin,
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