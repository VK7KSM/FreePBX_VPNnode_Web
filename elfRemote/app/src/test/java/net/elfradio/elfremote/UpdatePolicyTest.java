package net.elfradio.elfremote;

import org.json.JSONObject;
import org.junit.Test;

import java.security.KeyPair;
import java.security.KeyPairGenerator;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class UpdatePolicyTest {
    @Test public void storagePreflightReservesDownloadInstallAndBackupSpace() {
        long required = 2 * 300000L + 280000L + 1024 * 1024L;
        assertTrue(UpdatePolicy.hasStagingSpace(required, 300000, 280000));
        assertFalse(UpdatePolicy.hasStagingSpace(required - 1, 300000, 280000));
        assertFalse(UpdatePolicy.hasStagingSpace(Long.MAX_VALUE, 300000, Long.MAX_VALUE));
        assertFalse(UpdatePolicy.hasStagingSpace(required, 300000, 0));
        assertFalse(UpdatePolicy.hasStagingSpace(-1, 300000, 280000));
    }
    @Test public void manifestSizeMustFitDownloadLimitWithoutIntegerWrap() throws Exception {
        for (long size : new long[]{0, -1, UpdatePolicy.MAX_APK_BYTES + 1, 4294967297L}) {
            JSONObject m = goodManifest(85, "target").put("size", size);
            assertEquals(null, UpdatePolicy.parseManifest(m.toString()));
        }
        assertTrue(UpdatePolicy.parseManifest(goodManifest(85, "target").put("size", UpdatePolicy.MAX_APK_BYTES).toString()) != null);
    }
    @Test
    public void applicationReadinessCannotReplaceRootKeeperVerification() {
        UpdatePolicy.Health h = new UpdatePolicy.Health();
        h.versionCode = 80; h.versionName = "target";
        h.identityOk = true; h.reportOk = true;
        assertTrue(UpdatePolicy.applicationHealthy(h, "target", 80));
        assertFalse(UpdatePolicy.healthy(h, "target", 80));
        h.watchdogAlive = true; h.updaterAlive = true;
        assertTrue(UpdatePolicy.healthy(h, "target", 80));
        h.reportOk = false;
        assertFalse(UpdatePolicy.applicationHealthy(h, "target", 80));
        h.reportOk = true;
        assertFalse(UpdatePolicy.applicationHealthy(h, "target", 81));
    }
    @Test
    public void interruptedInstallCannotOverwriteItsHealthyBackup() {
        assertTrue(UpdatePolicy.preserveBackup("one","one",UpdatePolicy.ST_INSTALLING,true));
        assertTrue(UpdatePolicy.preserveBackup("one","one",UpdatePolicy.ST_WAIT_HEALTH,true));
        assertTrue(UpdatePolicy.preserveBackup("one","one",UpdatePolicy.ST_ROLLBACK,true));
        assertFalse(UpdatePolicy.preserveBackup("two","one",UpdatePolicy.ST_INSTALLING,true));
        assertFalse(UpdatePolicy.preserveBackup("one","one",UpdatePolicy.ST_CLAIMED,true));
        assertFalse(UpdatePolicy.preserveBackup("one","one",UpdatePolicy.ST_INSTALLING,false));
    }
    @Test(expected=IllegalArgumentException.class)
    public void systemInstallerRejectsUncontrolledPaths() {
        UpdatePolicy.systemInstallCommand("/tmp/untrusted'; echo SYS_OK");
    }

    @Test
    public void signedManifestCannotSubstituteForActualArchiveMetadata() throws Exception {
        JSONObject m=goodManifest(68,"0.1.67");
        String cert=m.getString("certSha256");
        assertTrue(UpdatePolicy.archiveMatches(m,UpdatePolicy.PKG,68,"0.1.67",cert));
        assertFalse(UpdatePolicy.archiveMatches(m,"other.package",68,"0.1.67",cert));
        assertFalse(UpdatePolicy.archiveMatches(m,UpdatePolicy.PKG,67,"0.1.67",cert));
        assertFalse(UpdatePolicy.archiveMatches(m,UpdatePolicy.PKG,68,"different",cert));
        assertFalse(UpdatePolicy.archiveMatches(m,UpdatePolicy.PKG,68,"0.1.67",""));
        assertFalse(UpdatePolicy.archiveMatches(m,UpdatePolicy.PKG,68,"0.1.67",UpdatePolicy.sha256Hex(new byte[]{1})));
    }

    @Test
    public void parseManifestRequiresPackageHashAndVersion() throws Exception {
        assertEquals(null, UpdatePolicy.parseManifest(null));
        assertEquals(null, UpdatePolicy.parseManifest("{}"));
        JSONObject m = UpdatePolicy.parseManifest(goodManifest(13, "0.1.12-d22xx-updb").toString());
        assertEquals("net.elfradio.elfremote", m.getString("package"));
        assertEquals(13, m.getInt("versionCode"));
        assertEquals(64, m.getString("sha256").length());
    }

    @Test
    public void parseManifestRejectsLoopbackUrlAndBadHash() throws Exception {
        JSONObject badHash = goodManifest(13, "0.1.12-d22xx-updb");
        badHash.put("sha256", "xyz");
        assertEquals(null, UpdatePolicy.parseManifest(badHash.toString()));
        JSONObject badUrl = goodManifest(13, "0.1.12-d22xx-updb");
        badUrl.put("url", "http://127.0.0.1/x.apk");
        assertEquals(null, UpdatePolicy.parseManifest(badUrl.toString()));
        JSONObject fileUrl = goodManifest(13, "0.1.12-d22xx-updb");
        fileUrl.put("url", "file:///data/local/tmp/x.apk");
        assertEquals(null, UpdatePolicy.parseManifest(fileUrl.toString()));
    }

    @Test
    public void expiredManifestIsRejectedAtOfferTime() throws Exception {
        JSONObject m = goodManifest(13, "0.1.12-d22xx-updb");
        m.put("expires_at", 1L);
        assertTrue(UpdatePolicy.expired(m, 2L));
        m.put("expires_at", 5000L);
        assertFalse(UpdatePolicy.expired(m, 1000L));
    }

    @Test
    public void apkBytesMustMatchSizeAndSha256() throws Exception {
        byte[] apk = "apk-bytes".getBytes("UTF-8");
        String sha = UpdatePolicy.sha256Hex(apk);
        assertTrue(UpdatePolicy.apkMatches(apk, apk.length, sha));
        assertFalse(UpdatePolicy.apkMatches(apk, apk.length + 1, sha));
        assertFalse(UpdatePolicy.apkMatches(apk, apk.length, "aa" + sha.substring(2)));
    }

    @Test
    public void alreadyOnTargetSkipsInstall() {
        assertTrue(UpdatePolicy.alreadyOnTarget("0.1.12-d22xx-updb", 13, "0.1.12-d22xx-updb", 13));
        assertFalse(UpdatePolicy.alreadyOnTarget("0.1.11-d22xx-upda", 12, "0.1.12-d22xx-updb", 13));
    }

    @Test
    public void healthyUpdateRequiresVersionIdentityReportAndKeepers() {
        UpdatePolicy.Health h = new UpdatePolicy.Health();
        h.versionName = "0.1.12-d22xx-updb";
        h.versionCode = 13;
        h.identityOk = true;
        h.reportOk = true;
        h.watchdogAlive = true;
        h.updaterAlive = true;
        assertTrue(UpdatePolicy.healthy(h, "0.1.12-d22xx-updb", 13));
        h.reportOk = false;
        assertFalse(UpdatePolicy.healthy(h, "0.1.12-d22xx-updb", 13));
        h.reportOk = true;
        h.versionCode = 12;
        assertFalse(UpdatePolicy.healthy(h, "0.1.12-d22xx-updb", 13));
    }

    @Test
    public void rsaSignatureRoundTrip() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        KeyPair kp = g.generateKeyPair();
        String pem = UpdatePolicy.publicKeyPem(kp.getPublic());
        byte[] payload = goodManifest(13, "0.1.12-d22xx-updb").toString().getBytes("UTF-8");
        String sig = UpdatePolicy.sign(kp.getPrivate(), payload);
        assertTrue(UpdatePolicy.verifySignature(pem, payload, sig));
        payload[0] ^= 1;
        assertFalse(UpdatePolicy.verifySignature(pem, payload, sig));
    }

    @Test
    public void stagesAreOrderedAndPmInstallIsNotSuccess() {
        assertEquals("pending", UpdatePolicy.ST_PENDING);
        assertEquals("wait_health", UpdatePolicy.ST_WAIT_HEALTH);
        assertEquals("success", UpdatePolicy.ST_SUCCESS);
        assertTrue(UpdatePolicy.canAdvance("pending", "claimed"));
        assertTrue(UpdatePolicy.canAdvance("installing", "wait_health"));
        assertTrue(UpdatePolicy.canAdvance("installing", "rollback"));
        assertTrue(UpdatePolicy.canAdvance("verifying", "rollback"));
        assertTrue(UpdatePolicy.canAdvance("downloading", "rollback"));
        assertFalse(UpdatePolicy.canAdvance("installing", "success"));
        assertEquals("rejected", UpdatePolicy.ST_REJECTED);
        assertTrue(UpdatePolicy.canAdvance("verifying", UpdatePolicy.ST_REJECTED));
        assertFalse(UpdatePolicy.canAdvance("rejected", "installing"));
        assertTrue(UpdatePolicy.canAdvance("wait_health", "success"));
        assertTrue(UpdatePolicy.canAdvance("wait_health", "rollback"));
        assertTrue(UpdatePolicy.canAdvance("rollback", "recovered"));
        assertFalse(UpdatePolicy.canAdvance("wait_health", "recovered"));
        assertFalse(UpdatePolicy.installOutputMeansHealthy("Success"));
        assertFalse(UpdatePolicy.installOutputMeansHealthy("pkg installed"));
    }

    @Test
    public void healthWaitTimesOutThenRollback() {
        assertFalse(UpdatePolicy.healthTimedOut(1000L, 2000L, 90_000L));
        assertTrue(UpdatePolicy.healthTimedOut(1000L, 91_001L, 90_000L));
        assertEquals("/data/local/elfremote/last_good.apk", UpdatePolicy.LAST_GOOD_APK);
        assertEquals("rollback", UpdatePolicy.ST_ROLLBACK);
        assertEquals("recovered", UpdatePolicy.ST_RECOVERED);
    }

    @Test
    public void jobShellUsesCopiedUpdaterApkNotLivePackage() {
        String sh = UpdatePolicy.jobShell("/data/local/elfremote/update.job.json");
        assertTrue(sh.contains("CLASSPATH=/data/local/elfremote/updater.apk"));
        assertFalse(sh.contains("CLASSPATH=/system/app/ElfRemote/ElfRemote.apk"));
        assertEquals("/data/local/elfremote/updater.apk", UpdatePolicy.UPDATER_APK);
    }

    @Test
    public void installKillResumeWaitsHealthInsteadOfRedownload() {
        assertEquals(UpdatePolicy.ST_WAIT_HEALTH,
                UpdatePolicy.resumeAction(UpdatePolicy.ST_INSTALLING, true, false, true, "j1", "j1"));
        assertEquals(UpdatePolicy.ST_WAIT_HEALTH,
                UpdatePolicy.resumeAction(UpdatePolicy.ST_SUCCESS, true, false, true, "j1", "j1"));
        assertEquals(UpdatePolicy.ST_SUCCESS,
                UpdatePolicy.resumeAction(UpdatePolicy.ST_WAIT_HEALTH, true, true, true, "j1", "j1"));
    }

    @Test
    public void rollbackKillResumePostsRecoveredAndDoesNotReinstallTarget() {
        assertEquals(UpdatePolicy.ST_RECOVERED,
                UpdatePolicy.resumeAction(UpdatePolicy.ST_WAIT_HEALTH, false, false, true, "j1", "j1"));
        assertEquals(UpdatePolicy.ST_RECOVERED,
                UpdatePolicy.resumeAction(UpdatePolicy.ST_ROLLBACK, false, false, true, "j1", "j1"));
        assertEquals(UpdatePolicy.ST_ROLLBACK,
                UpdatePolicy.resumeAction(UpdatePolicy.ST_ROLLBACK, true, false, true, "j1", "j1"));
    }

    @Test
    public void leftoverRecoveredDoesNotSkipANewJob() {
        assertEquals(UpdatePolicy.ST_DOWNLOADING,
                UpdatePolicy.resumeAction(UpdatePolicy.ST_RECOVERED, false, false, true, "old", "new"));
        assertEquals(UpdatePolicy.ST_DOWNLOADING,
                UpdatePolicy.resumeAction(UpdatePolicy.ST_WAIT_HEALTH, false, false, true, "old", "new"));
    }

    @Test
    public void rollbackInstallAllowsVersionDowngrade() {
        String[] argv = UpdatePolicy.pmInstallArgv("/data/local/elfremote/last_good.apk");
        assertEquals("pm", argv[0]);
        assertEquals("install", argv[1]);
        boolean dashD = false;
        boolean dashR = false;
        for (int i = 0; i < argv.length; i++) {
            if ("-d".equals(argv[i])) dashD = true;
            if ("-r".equals(argv[i])) dashR = true;
        }
        assertTrue(dashR);
        assertTrue(dashD);
        assertEquals("/data/local/elfremote/last_good.apk", argv[argv.length - 1]);
    }

    @Test
    public void incompleteInstallRetriesDownload() {
        assertEquals(UpdatePolicy.ST_DOWNLOADING,
                UpdatePolicy.resumeAction(UpdatePolicy.ST_INSTALLING, false, false, true, "j1", "j1"));
        assertEquals(UpdatePolicy.ST_DOWNLOADING,
                UpdatePolicy.resumeAction(UpdatePolicy.ST_CLAIMED, false, false, false, "j1", "j1"));
    }

    private static JSONObject goodManifest(int code, String name) throws Exception {
        JSONObject m = new JSONObject();
        m.put("package", "net.elfradio.elfremote");
        m.put("versionCode", code);
        m.put("versionName", name);
        m.put("size", 9);
        m.put("sha256", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        m.put("certSha256", "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210");
        m.put("url", "https://v.elfradio.net/api/elfremote/apk/job1");
        m.put("job_id", "job1");
        m.put("expires_at", 4102444800000L);
        return m;
    }

    @org.junit.Test public void executionAttemptDoesNotModifySignedArtifactAndChecksTargetAndExpiry() throws Exception {
        org.json.JSONObject artifact = new org.json.JSONObject().put("job_id", "published").put("expires_at", 0);
        org.json.JSONObject task = new org.json.JSONObject().put("task_id", "update-attempt-one")
                .put("task_device_id", "device").put("task_expires_at", 2000);
        org.json.JSONObject actual = UpdatePolicy.executionManifest(artifact, task, "device", 1000);
        org.junit.Assert.assertEquals("update-attempt-one", actual.getString("job_id"));
        org.junit.Assert.assertEquals("published", artifact.getString("job_id"));
        org.junit.Assert.assertNull(UpdatePolicy.executionManifest(artifact, task, "other", 1000));
        org.junit.Assert.assertNull(UpdatePolicy.executionManifest(artifact, task, "device", 2000));
        artifact.put("expires_at", 900);
        org.junit.Assert.assertNull(UpdatePolicy.executionManifest(artifact, task, "device", 1000));
    }
}
