import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

/* ===================================================== */
/* LOAD ENVIRONMENT                                      */
/* ===================================================== */

dotenv.config();

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PORT } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing Supabase environment variables");
  process.exit(1);
}

/* ===================================================== */
/* INITIALIZE EXPRESS                                    */
/* ===================================================== */

const app = express();

app.use(
  cors({
    origin: "*", // ⚠️ Restrict in production
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

app.use(express.json({ limit: "10mb" }));

/* ===================================================== */
/* SUPABASE SERVICE ROLE CLIENT                          */
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
/* ASYNC HANDLER                                         */
/* ===================================================== */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/* ===================================================== */
/* AUTH MIDDLEWARE                                       */
/* ===================================================== */

const verifyToken = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Missing or invalid Authorization header",
    });
  }

  const token = authHeader.split(" ")[1];

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired token",
    });
  }

  req.user = data.user;
  next();
});

/* ===================================================== */
/* ROLE MIDDLEWARE                                       */
/* ===================================================== */

const requireAdmin = asyncHandler(async (req, res, next) => {
  const { data } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", req.user.id)
    .single();

  if (!data || data.role !== "admin") {
    return res.status(403).json({
      error: "Forbidden",
      message: "Admin access required",
    });
  }

  req.userRole = data.role;
  next();
});

const requireAdminOrInstructor = asyncHandler(async (req, res, next) => {
  const { data } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", req.user.id)
    .single();

  if (!data || !["admin", "instructor"].includes(data.role)) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Admin or Instructor access required",
    });
  }

  req.userRole = data.role;
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
      .order("created_at", { ascending: false });

    if (role) query = query.eq("role", role);

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  })
);

/* ===================================================== */
/* INSTRUCTORS (ADMIN ONLY)                              */
/* ===================================================== */

app.get(
  "/api/instructors",
  verifyToken,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, name, role, avatar, created_at")
      .eq("role", "instructor")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);
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

    res.json(data);
  })
);

/* ===================================================== */
/* COURSE DETAILS (ADMIN ONLY)                           */
/* ===================================================== */

app.get(
  "/api/courses/:id",
  verifyToken,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("courses")
      .select(`
        *,
        profiles:instructor_id ( id, name )
      `)
      .eq("id", id)
      .single();

    if (error || !data) {
      return res.status(404).json({
        error: "Not Found",
        message: "Course not found",
      });
    }

    res.json(data);
  })
);

/* ===================================================== */
/* LIVE SESSIONS (ADMIN + INSTRUCTOR)                    */
/* ===================================================== */

app.get(
  "/api/live-sessions",
  verifyToken,
  requireAdminOrInstructor,
  asyncHandler(async (req, res) => {
    let query = supabase
      .from("live_sessions")
      .select(`
        id,
        title,
        course,
        start_time,
        status,
        instructor_id,
        profiles:instructor_id ( id, name )
      `)
      .order("start_time", { ascending: false });

    if (req.userRole === "instructor") {
      query = query.eq("instructor_id", req.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  })
);

/* ===================================================== */
/* ANNOUNCEMENTS (ADMIN ONLY)                            */
/* ===================================================== */

app.get(
  "/api/announcements",
  verifyToken,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from("announcements")
      .select(`
        id,
        title,
        content,
        priority,
        created_at,
        profiles:author_id ( name )
      `)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const formatted = data.map((a) => ({
      id: a.id,
      title: a.title,
      content: a.content,
      priority: a.priority,
      created_at: a.created_at,
      author: a.profiles?.name || "Admin",
    }));

    res.json(formatted);
  })
);

/* ===================================================== */
/* 404 HANDLER                                           */
/* ===================================================== */

app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: "API route not found",
  });
});

/* ===================================================== */
/* GLOBAL ERROR HANDLER                                  */
/* ===================================================== */

app.use((err, req, res, next) => {
  console.error("🚨 SERVER ERROR:", err);

  res.status(500).json({
    error: "Internal Server Error",
    message: err.message || "Something went wrong",
  });
});

/* ===================================================== */
/* START SERVER                                          */
/* ===================================================== */

const serverPort = PORT || 5050;

app.listen(serverPort, "0.0.0.0", () => {
  console.log(`🚀 LMS Backend running on port ${serverPort}`);
});