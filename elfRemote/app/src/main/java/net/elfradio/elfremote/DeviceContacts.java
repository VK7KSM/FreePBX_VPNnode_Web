package net.elfradio.elfremote;

import android.content.*;
import android.database.Cursor;
import android.provider.ContactsContract;
import android.provider.ContactsContract.CommonDataKinds.Phone;
import android.provider.ContactsContract.CommonDataKinds.StructuredName;
import org.json.*;
import java.util.ArrayList;

final class DeviceContacts {
    private final Context context;
    private final ContentResolver resolver;
    DeviceContacts(Context context) { this.context=context; resolver=context.getContentResolver(); }

    private void permission() throws Exception {
        for (String name : new String[]{"android.permission.READ_CONTACTS","android.permission.WRITE_CONTACTS"}) {
            if (context.checkSelfPermission(name)==android.content.pm.PackageManager.PERMISSION_GRANTED) continue;
            throw new java.io.IOException("contacts-permission-initialization-pending");
        }
    }

    JSONObject execute(String taskId, String type, JSONObject params) throws Exception {
        ConfigPolicy.contact(type,params); permission();
        if ("contacts_read".equals(type)) return read();
        ArrayList<ContentProviderOperation> ops=new ArrayList<>();
        if ("contact_add".equals(type)) {
            // 与联系人原子写入相同的任务标记，防止回执丢失后重复新增。
            try(Cursor c=resolver.query(ContactsContract.RawContacts.CONTENT_URI,new String[]{"_id"},"sync1=? AND deleted=0",new String[]{"elfremote:"+taskId},null)) {
                if(c==null) throw new java.io.IOException("contacts-provider-unavailable");
                if(c.moveToFirst()) return read();
            }
            ops.add(ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                    .withValue("account_type",null).withValue("account_name",null).withValue("sync1","elfremote:"+taskId).build());
            ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValueBackReference("raw_contact_id",0)
                    .withValue("mimetype",StructuredName.CONTENT_ITEM_TYPE).withValue(StructuredName.DISPLAY_NAME,params.getString("name").trim()).build());
            ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValueBackReference("raw_contact_id",0)
                    .withValue("mimetype",Phone.CONTENT_ITEM_TYPE).withValue(Phone.NUMBER,params.getString("phone").trim()).withValue(Phone.TYPE,Phone.TYPE_MOBILE).build());
        } else {
            long id=params.getLong("id"), raw;
            try(Cursor c=resolver.query(ContactsContract.Data.CONTENT_URI,new String[]{"raw_contact_id"},"_id=? AND mimetype=?",new String[]{Long.toString(id),Phone.CONTENT_ITEM_TYPE},null)) {
                if(c==null) throw new java.io.IOException("contacts-provider-unavailable");
                if(!c.moveToFirst()) {
                    if("contact_delete".equals(type)) return read();
                    throw new java.io.IOException("contact-not-found");
                }
                raw=c.getLong(0);
            }
            if("contact_delete".equals(type)) {
                boolean own=false, simple=true;int phones=0;
                try(Cursor c=resolver.query(ContactsContract.RawContacts.CONTENT_URI,new String[]{"sync1"},"_id=?",new String[]{Long.toString(raw)},null)) {
                    own=c!=null && c.moveToFirst() && c.getString(0)!=null && c.getString(0).startsWith("elfremote:");
                }
                try(Cursor c=resolver.query(ContactsContract.Data.CONTENT_URI,new String[]{"mimetype"},"raw_contact_id=?",new String[]{Long.toString(raw)},null)) {
                    if(c==null) simple=false;
                    else while(c.moveToNext()) {String mime=c.getString(0);if(Phone.CONTENT_ITEM_TYPE.equals(mime)) phones++;else if(!StructuredName.CONTENT_ITEM_TYPE.equals(mime)) simple=false;}
                }
                // 页面的一行对应一个号码；不连带删除同联系人其他号码和资料。
                if(own && simple && phones==1) ops.add(ContentProviderOperation.newDelete(ContactsContract.RawContacts.CONTENT_URI).withSelection("_id=?",new String[]{Long.toString(raw)}).build());
                else ops.add(ContentProviderOperation.newDelete(ContactsContract.Data.CONTENT_URI).withSelection("_id=? AND mimetype=?",new String[]{Long.toString(id),Phone.CONTENT_ITEM_TYPE}).build());
            } else {
                ops.add(ContentProviderOperation.newUpdate(ContactsContract.Data.CONTENT_URI).withSelection("_id=? AND mimetype=?",new String[]{Long.toString(id),Phone.CONTENT_ITEM_TYPE})
                        .withValue(Phone.NUMBER,params.getString("phone").trim()).withExpectedCount(1).build());
                long nameId=-1;
                try(Cursor c=resolver.query(ContactsContract.Data.CONTENT_URI,new String[]{"_id"},"raw_contact_id=? AND mimetype=?",new String[]{Long.toString(raw),StructuredName.CONTENT_ITEM_TYPE},null)) {
                    if(c==null) throw new java.io.IOException("contacts-provider-unavailable");
                    if(c.moveToFirst()) nameId=c.getLong(0);
                }
                ContentProviderOperation.Builder op=nameId<0 ? ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                        .withValue("raw_contact_id",raw).withValue("mimetype",StructuredName.CONTENT_ITEM_TYPE)
                        : ContentProviderOperation.newUpdate(ContactsContract.Data.CONTENT_URI).withSelection("_id=?",new String[]{Long.toString(nameId)}).withExpectedCount(1);
                ops.add(op.withValue(StructuredName.DISPLAY_NAME,params.getString("name").trim()).build());
            }
        }
        resolver.applyBatch(ContactsContract.AUTHORITY,ops);
        RuntimeLog.event("contacts_operation_complete type="+type);
        return read();
    }

    private JSONObject read() throws Exception {
        JSONArray items=new JSONArray(); boolean truncated=false;
        try(Cursor c=resolver.query(Phone.CONTENT_URI,new String[]{Phone._ID,Phone.DISPLAY_NAME,Phone.NUMBER},null,null,Phone._ID+" ASC")) {
            if(c==null) throw new java.io.IOException("contacts-provider-unavailable");
            while(c.moveToNext()) {
                if(items.length()==1000) {truncated=true;break;}
                items.put(new JSONObject().put("id",c.getLong(0)).put("name",c.isNull(1)?"":c.getString(1)).put("phone",c.isNull(2)?"":c.getString(2)));
            }
        }
        return new JSONObject().put("sampled_at_ms",System.currentTimeMillis()).put("items",items).put("truncated",truncated);
    }
}
