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
/* INITIALIZE APP                                        */
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
/* SUPABASE ADMIN CLIENT                                 */
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
  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", req.user.id)
    .single();

  if (error || !data || data.role !== "admin") {
    return res.status(403).json({
      error: "Forbidden",
      message: "Admin access required",
    });
  }

  req.userRole = data.role;
  next();
});

const requireAdminOrInstructor = asyncHandler(async (req, res, next) => {
  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", req.user.id)
    .single();

  if (error || !data) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Access denied",
    });
  }

  if (data.role !== "admin" && data.role !== "instructor") {
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
      .select("id, name, email, role, avatar, created_at")
      .order("name", { ascending: true });

    if (role) query = query.eq("role", role);

    const { data, error } = await query;
    if (error) throw error;

    res.status(200).json(data);
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
      .select("id, name, email, avatar, created_at")
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
        error: "Validation Error",
        message: "Name and email are required",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

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

    res.status(200).json(data);
  })
);

app.post(
  "/api/live-sessions",
  verifyToken,
  requireAdminOrInstructor,
  asyncHandler(async (req, res) => {
    const { title, course, start_time, status, instructor_id } = req.body;

    if (!title || !course || !start_time) {
      return res.status(400).json({
        error: "Validation Error",
        message: "title, course, start_time required",
      });
    }

    const finalInstructorId =
      req.userRole === "instructor"
        ? req.user.id
        : instructor_id;

    if (!finalInstructorId) {
      return res.status(400).json({
        error: "Instructor required",
      });
    }

    const { data, error } = await supabase
      .from("live_sessions")
      .insert({
        title,
        course,
        start_time,
        status: status || "upcoming",
        instructor_id: finalInstructorId,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  })
);

app.put(
  "/api/live-sessions/:id",
  verifyToken,
  requireAdminOrInstructor,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (req.userRole === "instructor") {
      const { data } = await supabase
        .from("live_sessions")
        .select("instructor_id")
        .eq("id", id)
        .single();

      if (!data || data.instructor_id !== req.user.id) {
        return res.status(403).json({
          error: "Forbidden",
          message: "You can only edit your own sessions",
        });
      }
    }

    const { data, error } = await supabase
      .from("live_sessions")
      .update(req.body)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json(data);
  })
);

app.delete(
  "/api/live-sessions/:id",
  verifyToken,
  requireAdminOrInstructor,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (req.userRole === "instructor") {
      const { data } = await supabase
        .from("live_sessions")
        .select("instructor_id")
        .eq("id", id)
        .single();

      if (!data || data.instructor_id !== req.user.id) {
        return res.status(403).json({
          error: "Forbidden",
          message: "You can only delete your own sessions",
        });
      }
    }

    const { error } = await supabase
      .from("live_sessions")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: "Live session deleted successfully",
    });
  })
);

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