import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

/* ===================================================== */
/* 1. INITIALIZATION & CONFIG                            */
/* ===================================================== */

dotenv.config();

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PORT } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing Supabase environment variables.");
  process.exit(1);
}

const app = express();
const serverPort = PORT || 5050;

// Initialize Supabase Service Role Client (Bypasses RLS)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/* ===================================================== */
/* 2. GLOBAL MIDDLEWARE                                  */
/* ===================================================== */

app.use(
  cors({
    origin: "*", // ⚠️ Restrict to specific domains in production
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  })
);

app.use(express.json({ limit: "10mb" }));

// Helper to catch async errors without try/catch blocks in every route
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/* ===================================================== */
/* 3. AUTH & ROLE MIDDLEWARES                            */
/* ===================================================== */

const verifyToken = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
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

// Dynamic Role Middleware Factory (Replaces separate admin/instructor middlewares)
const checkRole = (allowedRoles) =>
  asyncHandler(async (req, res, next) => {
    const { data, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", req.user.id)
      .single();

    if (error || !data || !allowedRoles.includes(data.role)) {
      return res.status(403).json({
        error: "Forbidden",
        message: `Requires one of the following roles: ${allowedRoles.join(", ")}`,
      });
    }

    req.userRole = data.role;
    next();
  });

/* ===================================================== */
/* 4. API ROUTES                                         */
/* ===================================================== */

const apiRouter = express.Router();

// Health Check
apiRouter.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", message: "🚀 LMS Backend API running" });
});

// Users (Admin Only)
apiRouter.get(
  "/users",
  verifyToken,
  checkRole(["admin"]),
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

// Instructors (Admin Only)
apiRouter.get(
  "/instructors",
  verifyToken,
  checkRole(["admin"]),
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

// Courses (Admin Only)
apiRouter.get(
  "/courses",
  verifyToken,
  checkRole(["admin"]),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from("courses")
      .select(`
        id, title, short_desc, thumbnail_url, category, level, status, created_at,
        profiles:instructor_id ( id, name )
      `)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);
  })
);

// Course Details (Admin Only)
apiRouter.get(
  "/courses/:id",
  verifyToken,
  checkRole(["admin"]),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from("courses")
      .select(`*, profiles:instructor_id ( id, name )`)
      .eq("id", req.params.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Not Found", message: "Course not found" });
    }

    res.json(data);
  })
);

// Live Sessions (Admin + Instructor)
apiRouter.get(
  "/live-sessions",
  verifyToken,
  checkRole(["admin", "instructor"]),
  asyncHandler(async (req, res) => {
    let query = supabase
      .from("live_sessions")
      .select(`
        id, title, course, start_time, status, instructor_id,
        profiles:instructor_id ( id, name )
      `)
      .order("start_time", { ascending: false });

    // If instructor, only show their own sessions
    if (req.userRole === "instructor") {
      query = query.eq("instructor_id", req.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  })
);

// Announcements (Admin Only)
apiRouter.get(
  "/announcements",
  verifyToken,
  checkRole(["admin"]),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from("announcements")
      .select(`id, title, content, priority, created_at, profiles:author_id ( name )`)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const formatted = data.map((a) => ({
      ...a,
      author: a.profiles?.name || "Admin",
      profiles: undefined, // Strip the nested object for a cleaner response
    }));

    res.json(formatted);
  })
);

// Mount API router
app.use("/api", apiRouter);

/* ===================================================== */
/* 5. ERROR HANDLING                                     */
/* ===================================================== */

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: "Not Found", message: "API route not found" });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("🚨 SERVER ERROR:", err);
  
  const statusCode = err.status || 500;
  res.status(statusCode).json({
    error: "Internal Server Error",
    message: err.message || "Something went wrong",
  });
});

/* ===================================================== */
/* 6. START SERVER                                       */
/* ===================================================== */

app.listen(serverPort, "0.0.0.0", () => {
  console.log(`🚀 LMS Backend running on port ${serverPort}`);
});