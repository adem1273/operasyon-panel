const { PrismaClient, UserRole } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo-agency" },
    update: { name: "Demo Agency" },
    create: {
      name: "Demo Agency",
      slug: "demo-agency"
    }
  });

  const passwordHash = await bcrypt.hash("Password123!", 10);

  const user = await prisma.user.upsert({
    where: {
      tenantId_email: {
        tenantId: tenant.id,
        email: "operator@demo.local"
      }
    },
    update: {
      fullName: "Demo Operator",
      role: UserRole.OPERATOR,
      passwordHash,
      phoneE164: "+905555555555",
      isActive: true,
      deletedAt: null
    },
    create: {
      tenantId: tenant.id,
      email: "operator@demo.local",
      fullName: "Demo Operator",
      role: UserRole.OPERATOR,
      passwordHash,
      phoneE164: "+905555555555"
    }
  });

  await prisma.userDevice.upsert({
    where: {
      tenantId_token: {
        tenantId: tenant.id,
        token: "demo-device-token-operator"
      }
    },
    update: {
      userId: user.id,
      platform: "WEB",
      isActive: true,
      lastSeenAt: new Date()
    },
    create: {
      tenantId: tenant.id,
      userId: user.id,
      token: "demo-device-token-operator",
      platform: "WEB",
      isActive: true,
      lastSeenAt: new Date()
    }
  });

  console.log("Seed completed");
  console.log(`tenantId=${tenant.id}`);
  console.log(`userId=${user.id}`);
  console.log("email=operator@demo.local");
  console.log("password=Password123!");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
