import { test, expect } from '@playwright/test';

test('responsive preview, themes, animation controls, and dialogs',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/'); await expect(page.locator('#connection')).toHaveText('SYSTEM OPERATIONAL');
 await page.evaluate(()=>document.fonts.ready);
 await page.setViewportSize({width:1440,height:1000});
 await page.screenshot({path:'docs/desktop-dark.png',fullPage:true,animations:'disabled'});
 await page.getByRole('button',{name:'Switch to light theme',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await page.screenshot({path:'docs/desktop-light.png',fullPage:true,animations:'disabled'});
 await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await page.getByRole('button',{name:'Pause animations',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-motion','paused');
 await page.locator('#how-open').click(); await expect(page.locator('#info-dialog')).toBeVisible(); await page.keyboard.press('Escape');
 for(const width of [320,375,390,768,1024,1440]){
  await page.setViewportSize({width,height:900});
  const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
  expect(dimensions.scroll,`Overflow at ${width}`).toBeLessThanOrEqual(dimensions.client);
 }
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'docs/mobile-light.png',fullPage:true,animations:'disabled'});
 await page.getByRole('button',{name:'Switch to dark theme',exact:true}).click();
 await page.screenshot({path:'docs/mobile-dark.png',fullPage:true,animations:'disabled'});
 await page.getByRole('button',{name:'LOG A PARCEL'}).click();await expect(page.locator('#auth-dialog')).toBeVisible();
 expect(errors).toEqual([]);
});

test('account, parcel lifecycle, search, export, and deletion',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/');
 await page.locator('#preview-signup').click();
 const form=page.locator('#auth-form');
 await form.getByLabel('Full name').fill('Delivery Tester');
 await form.getByLabel('Email address').fill(`parcelpass-${Date.now()}@example.com`);
 await form.getByLabel('Password',{exact:true}).fill('ParcelTest123!');
 await form.getByRole('button',{name:'CREATE MY LOCKER'}).click();
 await expect(page.locator('#auth-dialog')).not.toBeVisible();
 await expect(page.locator('#mode-label')).toHaveText('PRIVATE LOCKER');
 await page.locator('#add-parcel').click();
 const parcel=page.locator('#parcel-form');
 await parcel.getByLabel('What’s arriving?').fill('Desk lamp');
 await parcel.getByLabel('Courier',{exact:true}).fill('DHL');
 await parcel.getByLabel('Tracking number').fill('DHL123456');
 await parcel.getByLabel('Notes').fill('Warm white lamp');
 await parcel.getByRole('button',{name:'SAVE PARCEL'}).click();
 await expect(page.locator('#parcel-dialog')).not.toBeVisible();
 await expect(page.locator('#active-total')).toHaveText('01');
 await page.getByRole('button',{name:'Open Desk lamp',exact:true}).click();
 await parcel.getByLabel('Delivery status').selectOption('received');
 await parcel.getByRole('button',{name:'SAVE CHANGES'}).click();
 await expect(page.locator('#parcel-dialog')).not.toBeVisible();
 await page.getByRole('button',{name:'Received 1',exact:true}).click();
 await expect(page.getByRole('button',{name:'Desk lamp',exact:true})).toBeVisible();
 await page.locator('#search').fill('missing');await expect(page.getByText('No matching arrivals.')).toBeVisible();
 await page.locator('#search').fill('');
 const download=page.waitForEvent('download');await page.locator('#export').click();expect((await download).suggestedFilename()).toMatch(/parcelpass-manifest/);
 await page.reload();await expect(page.locator('#mode-label')).toHaveText('PRIVATE LOCKER');
 await page.locator('[data-filter="received"]').click();await page.getByRole('button',{name:'Open Desk lamp',exact:true}).click();
 await page.locator('#delete-parcel').click();await page.locator('#confirm-action').click();await expect(page.locator('#parcel-dialog')).not.toBeVisible();
 await page.locator('#settings-open').click();
 await page.locator('#settings-dialog').getByText('Delete account',{exact:true}).click();
 await page.locator('#delete-account-form input').fill('ParcelTest123!');
 await page.locator('#delete-account-form button').click();await page.locator('#confirm-action').click();
 await expect(page.locator('#mode-label')).toHaveText('PREVIEW MODE');
});
