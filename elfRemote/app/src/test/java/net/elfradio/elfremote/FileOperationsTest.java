package net.elfradio.elfremote;

import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import org.json.JSONObject;
import java.io.File;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class FileOperationsTest {
    @Rule public TemporaryFolder temp=new TemporaryFolder();
    private JSONObject run(String action,File source,File target)throws Exception {
        JSONObject p=new JSONObject().put("action",action).put("path",source.getAbsolutePath());
        if(target!=null)p.put("target",target.getAbsolutePath());
        return new JSONObject(FileOperations.run(temp.newFolder(),p).getString("output"));
    }
    @Test public void nestedCopyMoveAndRecoverableRemovalKeepOriginalBytes()throws Exception {
        File parent=temp.newFolder(),source=new File(parent,"源目录");source.mkdir();
        File child=new File(source,"引号'与空格.txt");Files.write(child.toPath(),new byte[]{1,2,3});
        File copy=new File(parent,"副本");run("copy",source,copy);
        assertArrayEquals(Files.readAllBytes(child.toPath()),Files.readAllBytes(new File(copy,child.getName()).toPath()));
        assertThrows(Exception.class,()->run("copy",source,copy));
        File renamed=new File(parent,"新名称");run("move",copy,renamed);assertFalse(copy.exists());
        JSONObject trashed=run("trash",renamed,null);File kept=new File(trashed.getString("path"));
        assertTrue(kept.isDirectory());assertFalse(renamed.exists());
        run("move",kept,renamed);assertTrue(new File(renamed,child.getName()).isFile());assertTrue(child.isFile());
    }
    @Test public void listPagesIncludeEmptyFilesAndLiteralNames()throws Exception {
        File dir=temp.newFolder();for(int i=0;i<51;i++)new File(dir,String.format("文件%02d",i)).createNewFile();
        JSONObject one=run("list",dir,null);assertEquals(51,one.getInt("total"));assertEquals(12,one.getInt("next"));
        JSONObject p=new JSONObject().put("action","list").put("path",dir.getAbsolutePath()).put("offset",40);
        JSONObject two=new JSONObject(FileOperations.run(temp.newFolder(),p).getString("output"));
        assertEquals(11,two.getJSONArray("entries").length());assertEquals(-1,two.getInt("next"));
        assertEquals(0,two.getJSONArray("entries").getJSONObject(0).getLong("bytes"));
    }
    @Test public void rejectsCopyIntoItselfAndCancellationDoesNotTouchSource()throws Exception {
        File dir=temp.newFolder();Files.write(new File(dir,"source").toPath(),new byte[]{4,5,6});
        assertThrows(Exception.class,()->run("copy",dir,new File(dir,"inside")));
        File job=temp.newFolder();new File(job,"cancel").createNewFile();File target=new File(temp.getRoot(),"copy-target");
        assertThrows(Exception.class,()->FileOperations.run(job,new JSONObject().put("action","copy").put("path",dir.getAbsolutePath()).put("target",target.getAbsolutePath())));
        assertTrue(new File(dir,"source").isFile());assertFalse(target.exists());
    }
    @Test public void pathsAreNotCommandsAndParentTraversalIsRejected()throws Exception {
        assertThrows(Exception.class,()->FileOperations.normalize(new JSONObject().put("action","list").put("path","/a/../b")));
        File root=temp.newFolder(),created=new File(root,"$name ' quote");run("mkdir",created,null);assertTrue(created.isDirectory());
    }
}
