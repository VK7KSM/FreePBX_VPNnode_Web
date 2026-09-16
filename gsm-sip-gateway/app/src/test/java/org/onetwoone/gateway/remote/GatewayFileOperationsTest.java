package org.onetwoone.gateway.remote;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayFileOperationsTest {
    @Rule public TemporaryFolder temp=new TemporaryFolder();
    @Test public void listsTwelveEntriesPerPage()throws Exception {File dir=temp.newFolder();for(int i=0;i<13;i++)Files.write(new File(dir,"f"+i).toPath(),new byte[]{1});JSONObject result=new JSONObject(GatewayFileOperations.run(new JSONObject().put("action","list").put("path",dir.getAbsolutePath()).put("offset",0)).getString("output"));assertEquals(12,result.getJSONArray("entries").length());assertEquals(12,result.getInt("next"));}
    @Test public void copiesAndVerifiesOrdinaryFile()throws Exception {File dir=temp.newFolder(),source=new File(dir,"a"),target=new File(dir,"b");Files.write(source.toPath(),"hello".getBytes(StandardCharsets.UTF_8));GatewayFileOperations.run(new JSONObject().put("action","copy").put("path",source.getAbsolutePath()).put("target",target.getAbsolutePath()));assertEquals("hello",new String(Files.readAllBytes(target.toPath()),StandardCharsets.UTF_8));}
    @Test public void overwriteRemovesPrivateBackup()throws Exception {File dir=temp.newFolder(),source=new File(dir,"a"),target=new File(dir,"b");Files.write(source.toPath(),"new".getBytes(StandardCharsets.UTF_8));Files.write(target.toPath(),"old".getBytes(StandardCharsets.UTF_8));GatewayFileOperations.run(new JSONObject().put("action","copy").put("path",source.getAbsolutePath()).put("target",target.getAbsolutePath()).put("overwrite",true));assertEquals("new",new String(Files.readAllBytes(target.toPath()),StandardCharsets.UTF_8));String[] names=dir.list();java.util.Arrays.sort(names);assertArrayEquals(new String[]{"a","b"},names);}
    @Test public void rejectsRelativeTraversalAndExtraFields()throws Exception {invalid(new JSONObject().put("action","list").put("path","../tmp"));invalid(new JSONObject().put("action","list").put("path",temp.getRoot().getAbsolutePath()).put("shell","id"));}
    private static void invalid(JSONObject value)throws Exception {try{GatewayFileOperations.normalize(value);fail();}catch(Exception expected){}}
}
