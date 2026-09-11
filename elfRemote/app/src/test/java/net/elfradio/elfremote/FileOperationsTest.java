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
    @Test public void deleteRemovesNestedFilesButLeavesSiblingAndOldTrash()throws Exception {
        File parent=temp.newFolder(),source=new File(parent,"要删除");source.mkdir();
        File nested=new File(source,"内部");nested.mkdir();Files.write(new File(nested,"内容.txt").toPath(),new byte[]{1,2});
        File sibling=new File(parent,"保留.txt"),oldTrash=new File(parent,".elfremote-trash-old");sibling.createNewFile();oldTrash.createNewFile();
        run("delete",source,null);
        assertFalse(source.exists());assertTrue(sibling.exists());assertTrue(oldTrash.exists());
        assertThrows(Exception.class,()->run("delete",source,null));
    }
    @Test public void deletionCancellationBeforeStartKeepsAllFiles()throws Exception {
        File dir=temp.newFolder(),child=new File(dir,"保留.txt");child.createNewFile();
        File job=temp.newFolder();new File(job,"cancel").createNewFile();
        assertThrows(Exception.class,()->FileOperations.run(job,new JSONObject().put("action","delete").put("path",dir.getAbsolutePath())));
        assertTrue(child.exists());
    }
    @Test public void deleteSymlinkNeverDeletesTarget()throws Exception {
        File parent=temp.newFolder(),target=temp.newFolder();File child=new File(target,"保留.txt");child.createNewFile();
        File link=new File(parent,"link");
        try{Files.createSymbolicLink(link.toPath(),target.toPath());}catch(Exception e){org.junit.Assume.assumeNoException(e);}
        run("delete",parent,null);assertFalse(parent.exists());assertTrue(child.exists());
    }
    @Test public void copyOverwriteKeepsOriginalTargetBackupAndRejectsAncestor()throws Exception {
        File parent=temp.newFolder(),source=new File(parent,"源.txt"),target=new File(parent,"目标.txt");
        Files.write(source.toPath(),new byte[]{1});Files.write(target.toPath(),new byte[]{2});File job=temp.newFolder();
        FileOperations.run(job,new JSONObject().put("action","copy").put("path",source.getAbsolutePath()).put("target",target.getAbsolutePath()).put("overwrite",true));
        assertArrayEquals(new byte[]{1},Files.readAllBytes(target.toPath()));
        assertArrayEquals(new byte[]{2},Files.readAllBytes(new File(parent,".elfremote-replaced-"+job.getName()+"-"+target.getName()).toPath()));
        assertThrows(Exception.class,()->FileOperations.run(temp.newFolder(),new JSONObject().put("action","move").put("path",source.getAbsolutePath()).put("target",parent.getAbsolutePath()).put("overwrite",true)));
        assertTrue(source.exists());
    }
}
