-- Enterprise RBAC, 2FA, sessions, audit ip.
ALTER TABLE "ApiKey" ADD COLUMN "createdById" INTEGER;
ALTER TABLE "AuditLog" ADD COLUMN "ip" TEXT;
ALTER TABLE "Org" ADD COLUMN "require2fa" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "sessionDays" INTEGER NOT NULL DEFAULT 14;
ALTER TABLE "Session" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "ip" TEXT,
ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "userAgent" TEXT;

CREATE TABLE "Role" (
    "id" SERIAL NOT NULL,
    "orgId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "system" BOOLEAN NOT NULL DEFAULT false,
    "permissions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Role_orgId_name_key" ON "Role"("orgId", "name");
ALTER TABLE "Role" ADD CONSTRAINT "Role_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- System roles for existing orgs. Permissions are empty here (deny-all) and filled in by the app at boot from permissions.ts.
INSERT INTO "Role" ("orgId", "name", "system", "permissions")
SELECT o."id", r.name, true, '{}' FROM "Org" o CROSS JOIN (VALUES ('Owner'), ('Admin'), ('Analyst'), ('Viewer')) AS r(name);

ALTER TABLE "User" ADD COLUMN "roleId" INTEGER,
ADD COLUMN "lastLoginAt" TIMESTAMP(3),
ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "recoveryCodes" TEXT[],
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "totpLastStep" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "totpSecret" TEXT;

-- Existing 'admin' users become their org's Owner so nobody loses access.
UPDATE "User" u SET "roleId" = (
  SELECT r."id" FROM "Role" r WHERE r."orgId" = u."orgId" AND r."name" =
    CASE u."role" WHEN 'admin' THEN 'Owner' WHEN 'analyst' THEN 'Analyst' ELSE 'Viewer' END
);
ALTER TABLE "User" ALTER COLUMN "roleId" SET NOT NULL;
ALTER TABLE "User" DROP COLUMN "role";
ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
